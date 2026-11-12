import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, SessionRateLimit, TurnUsage } from 'claude-code'

import type { Ledger, LedgerTask, Party, Rec, Report, Settings, Snapshot, Totals } from '../types'

type Dollar = EngineInterface

const P = 'abacus-aurora'
const PANE = 'aurora'
const BACKDROP = 'aurora-fireworks'
const PARTY_MS = 8000
// A calibration span closes once the account-wide window has moved this many points.
const SPAN = 1
// A gap this long breaks the span: other devices' use while this one idles would skew it.
const IDLE_MS = 10 * 60_000
// A live entry nobody has refreshed for this long belongs to a session that died.
const LIVE_TTL = 15 * 60_000
const SAMPLES = 20
// The account's live window figures, the same read /usage makes; polled so an idle device still sees resets and other devices' use.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000
// Another session on this device read the window this recently: skip this session's poll.
const FRESH_MS = 45_000
// Rough characters per output token, only for the live count while a response streams; the step's exact usage replaces it.
const CHARS_PER_TOKEN = 4
// Next-step and milestone wait this long after a turn ends; any new turn cancels them, so a burst of wake-ups pays once.
const SETTLE_MS = 30_000
// Prompts the engine raises on its own to carry on the user's work: they continue the running task, never start one.
const FOLLOW_UP_KINDS = new Set(['task-notification', 'auto-continuation', 'observer', 'observer-activity'])

const reports = atom({ plugin: 'abacus-aurora', key: 'reports' } as const, [] as Report[], { shape: 'reports-2' })
const snapshot = atom({ plugin: 'abacus-aurora', key: 'snapshot' } as const, { ledger: { tasks: [], live: {} }, samples: 0 } as Snapshot, { shape: 'snapshot-1' })
const party = atom({ plugin: 'abacus-aurora', key: 'party' } as const, null as Party | null)
const settings = atom({ plugin: 'abacus-aurora', key: 'settings' } as const, { recommend: true, celebrate: true } as Settings)
const dismissed = atom({ plugin: 'abacus-aurora', key: 'dismissed' } as const, [] as string[])
const totals = atom({ plugin: 'abacus-aurora', key: 'totals' } as const, { io: 0, cache: 0 } as Totals)

type Cur = {
  id: string
  title: string
  startedAt: number
  before?: number
  usd: number
  tokens: number
  io: number
  cache: number
  tools: Map<string, number>
  wrap?: { recap?: string; ask?: string }
  plan: { len: number; done: number; wrapped: boolean; items: string[] }
  turns: number
  durationMs: number
}

// A prompt the user gave (a new task) vs one the engine raised to continue the last one (a background result, a meta notice).
export const isFollowUp = (e: { text: string; isMeta?: boolean; origin?: { kind: string } }) =>
  e.isMeta === true || FOLLOW_UP_KINDS.has(e.origin?.kind ?? '') || /^\s*<(task-notification|side-sessions-event)>/.test(e.text)

// Device-wide calibration, shared by every session on this machine through the store.
type Cal = { reset?: string; anchor: number; prev: number; acc: number; exact: boolean; lastAt: number; samples: number[] }

const MODELS = [
  { name: 'Haiku 5.5', id: 'claude-haiku-5-5' },
  { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { name: 'Opus 5.5', id: 'claude-opus-5-5' },
  { name: 'Fable 5.1', id: 'claude-fable-5-1' },
] as const

const C = { mine: '#06d6a0', other: '#b5179e', free: '#8883', accent: '#4cc9f0', next: '#ffd166' }

const tokensOf = (u: TurnUsage) => u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const ioOf = (u: TurnUsage) => u.input_tokens + u.output_tokens
const cacheOf = (u: TurnUsage) => u.cache_read_input_tokens + u.cache_creation_input_tokens
// Fallback weight (pseudo-USD) only for a host with no cost ledger.
const tier = (model: string) => (/haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 3 : 5)
const pseudoUsd = (u: TurnUsage) =>
  tier(u.model) * 1e-6 * (u.input_tokens + u.output_tokens * 5 + u.cache_creation_input_tokens * 1.25 + u.cache_read_input_tokens * 0.1)

const fmt = (n: number) =>
  n < 1000 ? `${Math.round(n)}` : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 2 : 1)}K` : `${(n / 1e6).toFixed(2)}M`
const pct = (n: number | undefined) =>
  n === undefined ? '—' : n <= 0 ? '0%' : n < 0.1 ? '<0.1%' : `${n.toFixed(1)}%`
const dur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
const clock = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const win = (limits: readonly SessionRateLimit[] | undefined, kind: string) => limits?.find(l => l.kind === kind)
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const ms = (iso?: string) => (iso ? new Date(iso).getTime() : Number.NaN)
// Same 5-hour window when the reset times agree to within ten minutes (or either is unknown).
const sameWindow = (a?: string, b?: string) => {
  const x = ms(a)
  const y = ms(b)
  return Number.isNaN(x) || Number.isNaN(y) || Math.abs(x - y) < IDLE_MS
}

// Other devices only ever add to a span's movement, so the true rate sits at the low end of the samples.
export const rateOf = (samples: readonly number[]) => {
  if (samples.length === 0) return undefined
  const s = [...samples].sort((a, b) => a - b)
  if (s.length < 4) return s[0]
  const i = (s.length - 1) * 0.25
  const lo = Math.floor(i)
  return (s[lo] ?? 0) + ((s[lo + 1] ?? s[lo] ?? 0) - (s[lo] ?? 0)) * (i - lo)
}

export const calibrate = (cal: Cal, deltaUsd: number, reading: SessionRateLimit | undefined, now: number): Cal => {
  const c = { ...cal, samples: [...cal.samples], acc: cal.acc + Math.max(0, deltaUsd) }
  if (!reading) return c
  const p = reading.percentUsed
  const isCrossing = c.prev >= 0 && p !== c.prev
  if (c.anchor < 0 || !sameWindow(c.reset, reading.resetsAt) || p < c.anchor || now - c.lastAt > IDLE_MS) {
    c.anchor = p
    c.acc = 0
    c.exact = isCrossing || p === 0
  } else if (p - c.anchor >= SPAN) {
    if (c.exact && c.acc > 0) c.samples = [...c.samples, (p - c.anchor) / c.acc].slice(-SAMPLES)
    c.anchor = p
    c.acc = 0
    c.exact = true
  }
  c.prev = p
  c.lastAt = now
  c.reset = reading.resetsAt ?? c.reset
  return c
}

export type WindowView = {
  total?: number
  mine?: number
  other?: number
  rows: { id: string; title: string; share?: number; isLive: boolean; isHere: boolean }[]
}

// Splits the account-wide reading into this device's tasks and everything else; the device can never own more than the window.
export const splitWindow = (snap: Snapshot, sid: string, now: number): WindowView => {
  const l = snap.ledger
  const expired = !Number.isNaN(ms(l.reset)) && now > ms(l.reset)
  // A window that has reset reads 0 until the next request opens a new one, not the last figure seen.
  if (expired) return { total: 0, mine: snap.rate !== undefined ? 0 : undefined, other: snap.rate !== undefined ? 0 : undefined, rows: [] }
  const live = Object.entries(l.live).filter(([, v]) => now - v.at < LIVE_TTL)
  const raw = [
    ...live.map(([k, v]) => ({ id: `live-${k}`, title: v.title, usd: v.usd, isLive: true, isHere: k === sid })),
    ...[...l.tasks].reverse().map(t => ({ id: t.id, title: t.title, usd: t.usd, isLive: false, isHere: t.sid === sid })),
  ]
  const total = l.pct
  if (snap.rate === undefined) return { total, rows: raw.map(r => ({ ...r, share: undefined })) }
  const rate = snap.rate
  const mineRaw = raw.reduce((n, r) => n + r.usd * rate, 0)
  const scale = total !== undefined && mineRaw > total && mineRaw > 0 ? total / mineRaw : 1
  const mine = mineRaw * scale
  return {
    total,
    mine,
    other: total !== undefined ? Math.max(0, total - mine) : undefined,
    rows: raw.map(r => ({ id: r.id, title: r.title, share: r.usd * rate * scale, isLive: r.isLive, isHere: r.isHere })),
  }
}

// This device's tokens in the current window: every session's finished tasks plus the ones still running.
export const windowTokens = (snap: Snapshot, now: number): Totals => {
  const l = snap.ledger
  if (!Number.isNaN(ms(l.reset)) && now > ms(l.reset)) return { io: 0, cache: 0 }
  const rows = [...l.tasks, ...Object.values(l.live).filter(v => now - v.at < LIVE_TTL)]
  return rows.reduce((t, r) => ({ io: t.io + (r.io ?? 0), cache: t.cache + (r.cache ?? 0) }), { io: 0, cache: 0 })
}

// The usage endpoint's answer as rate-limit readings; utilization is already a percent there.
export const parseUsage = (text: string): SessionRateLimit[] => {
  const j = JSON.parse(text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null | undefined>
  const out: SessionRateLimit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const w = j[kind]
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue
    out.push({ kind, percentUsed: Math.round(w.utilization * 10) / 10, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) })
  }
  return out
}

// Fireworks + light sweeps as SMIL so the desktop animates them with no script.
const fireworks = (seed: number, w: number, h: number, bursts: number, loop: string) => {
  let s = seed || 1
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const colors = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f72585', '#b5179e', '#ffbe0b', '#80ffdb']
  let out = ''
  for (let i = 0; i < 3; i++) {
    const c = colors[(i * 3 + seed) % colors.length]
    out += `<rect x="-${w}" y="0" width="${w * 0.35}" height="${h}" fill="url(#beam)" opacity="0.5" transform="skewX(-20)" style="mix-blend-mode:screen"><animate attributeName="x" from="-${w * 0.6}" to="${w * 1.4}" dur="2.6s" begin="${(i * 0.9).toFixed(2)}s" repeatCount="${loop}"/><animate attributeName="fill-opacity" values="0;1;0" dur="2.6s" begin="${(i * 0.9).toFixed(2)}s" repeatCount="${loop}"/></rect>`
    out += `<circle cx="${w / 2}" cy="${h}" r="${h * 0.9}" fill="${c}" opacity="0"><animate attributeName="opacity" values="0;0.08;0" dur="2.4s" begin="${(i * 0.8 + 0.4).toFixed(2)}s" repeatCount="${loop}"/></circle>`
  }
  for (let b = 0; b < bursts; b++) {
    const x = Math.round(w * (0.1 + rnd() * 0.8))
    const y = Math.round(h * (0.12 + rnd() * 0.45))
    const c = colors[Math.floor(rnd() * colors.length)]
    const c2 = colors[Math.floor(rnd() * colors.length)]
    const begin = (rnd() * 2.2).toFixed(2)
    const rise = 0.55
    const d = 1.9
    const radius = Math.round(Math.min(w, h) * (0.12 + rnd() * 0.1))
    out += `<line x1="${x}" y1="${h}" x2="${x}" y2="${h}" stroke="${c}" stroke-width="2" stroke-linecap="round" opacity="0"><animate attributeName="y2" values="${h};${y}" dur="${rise}s" begin="${begin}s" repeatCount="${loop}"/><animate attributeName="y1" values="${h};${y + 40}" dur="${rise}s" begin="${begin}s" repeatCount="${loop}"/><animate attributeName="opacity" values="0;1;0" dur="${rise}s" begin="${begin}s" repeatCount="${loop}"/></line>`
    const start = (Number(begin) + rise).toFixed(2)
    out += `<circle cx="${x}" cy="${y}" r="2" fill="#fff" opacity="0"><animate attributeName="r" values="2;${radius * 0.5};2" dur="0.5s" begin="${start}s" repeatCount="${loop}"/><animate attributeName="opacity" values="0;0.9;0" dur="0.5s" begin="${start}s" repeatCount="${loop}"/></circle>`
    const n = 18
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * 2 * k) / n + rnd() * 0.2
      const dx = Math.round(Math.cos(a) * radius)
      const dy = Math.round(Math.sin(a) * radius)
      const col = k % 2 ? c : c2
      out += `<circle cx="${x}" cy="${y}" r="3" fill="${col}" opacity="0"><animate attributeName="cx" values="${x};${x + dx};${x + dx * 1.1}" keyTimes="0;0.6;1" dur="${d}s" begin="${start}s" repeatCount="${loop}"/><animate attributeName="cy" values="${y};${y + dy};${y + dy * 1.1 + 40}" keyTimes="0;0.6;1" dur="${d}s" begin="${start}s" repeatCount="${loop}"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.6;1" dur="${d}s" begin="${start}s" repeatCount="${loop}"/></circle>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff6c2" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>${out}</svg>`
}

// One bar for the whole window: this device, other devices, what is left.
const windowBar = (v: WindowView, width: number) => {
  const total = Math.min(100, v.total ?? 0)
  const mine = Math.min(total, v.mine ?? 0)
  const known = v.mine !== undefined
  const segs: [number, string][] = known ? [[mine, C.mine], [total - mine, C.other]] : [[total, C.accent]]
  let x = 0
  const rects = segs
    .map(([val, c]) => {
      const w = (val / 100) * width
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="8" fill="${c}"/>`
      x += w
      return r
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 8" width="${width}" height="8"><clipPath id="r"><rect width="${width}" height="8" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${width}" height="8" fill="${C.free}"/>${rects}</g></svg>`
}
const textBar = (v: WindowView, cells: number) => {
  const total = Math.min(100, v.total ?? 0)
  const mine = Math.min(total, v.mine ?? 0)
  const a = Math.round((mine / 100) * cells)
  const b = Math.round((total / 100) * cells) - a
  return `${'█'.repeat(a)}${'▓'.repeat(Math.max(0, b))}`.padEnd(cells, '░').slice(0, cells)
}

const quickRec = (r: Report): Rec => {
  const heavy = r.tokens > 3e6
  const pick = heavy ? MODELS[2] : MODELS[1]
  return {
    task: r.isAborted ? `Resume: ${short(r.title, 80)}` : 'Verify the change on device/simulator, then commit',
    model: pick.name,
    modelId: pick.id,
    effort: heavy ? 'high' : 'medium',
    why: heavy ? 'Large multi-step context benefits from deeper reasoning' : 'Routine follow-up; balanced speed and quality',
    source: 'quick',
  }
}

const REC_SYSTEM = `Pick the user's best NEXT coding task and the best Claude model. Reply with JSON only: {"task":"<imperative, max 90 chars>","model":"Haiku 5.5|Sonnet 5.5|Opus 5.5|Fable 5.1","effort":"low|medium|high","why":"<max 80 chars>"}. Haiku: mechanical edits, git, lookups. Sonnet: everyday features, fixes, tests. Opus: multi-file design, hard debugging. Fable: hardest long plans. Prefer the follow-up the assistant proposed; never repeat the finished task.`

let cur: Cur | null = null
// The last finished task; a turn with no new user prompt since resumes it.
let prev: Cur | null = null
let hasNewPrompt = false
// Bumped on every main-loop turn start; a settle timer from an older generation does nothing.
let settleGen = 0
let finals: Promise<unknown> = Promise.resolve()
let lastPrompt = ''
let counter = 0
let partyTimer: { cancel: () => void } | null = null
let sid = ''
let lastCost: number | undefined
let lastLiveWrite = 0
let lastSnap: Snapshot | null = null
let lastDraw = 0
let pollNote = ''
// Characters streamed so far by each response still in flight (several when subagents run).
const streaming = new Map<string, number>()
let chain: Promise<unknown> = Promise.resolve()
// Serialises this session's store read-modify-writes.
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

const emptyLedger = (): Ledger => ({ tasks: [], live: {} })
const loadCal = async ($: Dollar): Promise<Cal> => {
  const v = (await $.store.get('cal2')) as Cal | undefined
  return v && Array.isArray(v.samples) ? v : { anchor: -1, prev: -1, acc: 0, exact: false, lastAt: 0, samples: [] }
}
const loadLedger = async ($: Dollar): Promise<Ledger> => {
  const v = (await $.store.get('ledger2')) as Ledger | undefined
  return v && Array.isArray(v.tasks) ? { ...v, live: v.live ?? {} } : emptyLedger()
}

// Reads the store fresh (other sessions on this device write it too) and redraws only on a change.
const refresh = async ($: Dollar) => {
  const [l, cal] = await Promise.all([loadLedger($), loadCal($)])
  const next: Snapshot = { ledger: l, rate: rateOf(cal.samples), samples: cal.samples.length }
  const prev = await read($, snapshot)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, snapshot, () => next)
  lastSnap = next
  return next
}

const writeLedger = ($: Dollar, now: number, limits: readonly SessionRateLimit[] | undefined, fn: (l: Ledger) => void) =>
  serial(async () => {
    let l = await loadLedger($)
    const r5 = win(limits, 'five_hour')
    if (r5) {
      if (l.reset !== undefined && !sameWindow(l.reset, r5.resetsAt)) l = { ...emptyLedger(), weekly: l.weekly }
      l.reset = r5.resetsAt ?? l.reset
      l.pct = r5.percentUsed
      l.at = now
    }
    const w7 = win(limits, 'seven_day')
    if (w7) l.weekly = w7.percentUsed
    if (!Number.isNaN(ms(l.reset)) && now > ms(l.reset)) l = { ...emptyLedger(), weekly: l.weekly }
    l.live = Object.fromEntries(Object.entries(l.live).filter(([, v]) => now - v.at < LIVE_TTL))
    fn(l)
    l.tasks = l.tasks.slice(-80)
    await $.store.set('ledger2', l)
  })

// The running task's input + output tokens: exact for finished responses, estimated for the ones still streaming.
const liveIo = (task: Cur) => {
  let chars = 0
  for (const n of streaming.values()) chars += n
  return task.io + Math.round(chars / CHARS_PER_TOKEN)
}

const statusLine = async ($: Dollar, snap: Snapshot, now: number) => {
  const v = splitWindow(snap, sid, now)
  const parts = [`🧮 5h ${pct(v.total)}`]
  if (v.mine !== undefined) parts.push(`this device ${pct(v.mine)}`)
  const task = cur
  if (task) parts.push(`task ${fmt(liveIo(task))} tok`)
  else {
    const last = (await read($, reports)).at(-1)
    if (last?.io !== undefined) parts.push(`last task ${fmt(last.io)} tok`)
  }
  $.ui.status(parts.join(' · '))
}

// Redraws the strip from the last snapshot without touching the store; throttled for the streaming path.
const drawSoon = ($: Dollar, now: number) => {
  if (!lastSnap || now - lastDraw < 700) return
  lastDraw = now
  void statusLine($, lastSnap, now).catch(() => undefined)
}

// Reads the account's window figures straight from the usage endpoint, so the strip is right even when nothing has run since a reset.
const poll = async ($: Dollar, force = false) => {
  const now = await $.clock.now()
  const l = await loadLedger($)
  if (!force && l.at !== undefined && now - l.at < FRESH_MS) return
  const a = await $.session.authorize().catch(() => null)
  if (!a || a.kind !== 'bearer') {
    pollNote = 'no subscription sign-in; the window updates only from responses'
    return
  }
  const res = await $.http.fetch(USAGE_URL, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: a.handle }).catch((err: unknown) => {
    pollNote = `request refused: ${String(err).slice(0, 100)}`
    return null
  })
  if (!res) return
  if (!res.ok) {
    pollNote = `HTTP ${res.status}`
    return
  }
  let limits: SessionRateLimit[] = []
  try {
    limits = parseUsage(res.text)
  } catch {
    pollNote = 'unreadable answer'
    return
  }
  if (!win(limits, 'five_hour')) {
    pollNote = 'answer had no five_hour window'
    return
  }
  pollNote = `ok at ${new Date(now).toISOString().slice(11, 19)}Z: 5h ${win(limits, 'five_hour')?.percentUsed}%`
  await writeLedger($, now, limits, () => undefined)
  await statusLine($, await refresh($), now)
}

// Every API response: account-wide reading + this session's spend since the last one.
const onStep = async ($: Dollar, u: TurnUsage | undefined) => {
  const now = await $.clock.now()
  const usage = await $.session.usage().catch(() => null)
  const cost = usage?.cost?.usd
  let delta = 0
  if (cost !== undefined) {
    // Monotonic: overlapping subagent steps may read the total out of order.
    delta = lastCost !== undefined && cost > lastCost ? cost - lastCost : 0
    lastCost = lastCost === undefined ? cost : Math.max(lastCost, cost)
  } else if (u) {
    delta = pseudoUsd(u)
  }
  const task = cur
  if (task) task.usd += delta
  await serial(async () => {
    const cal = calibrate(await loadCal($), delta, win(usage?.rateLimits, 'five_hour'), now)
    await $.store.set('cal2', cal)
  })
  if (now - lastLiveWrite >= 2000 || !task) {
    lastLiveWrite = now
    await writeLedger($, now, usage?.rateLimits, l => {
      if (task) l.live[sid] = { title: short(task.title, 80), usd: task.usd, tokens: task.tokens, io: task.io, cache: task.cache, at: now }
    })
  }
  await statusLine($, await refresh($), now)
}

// Ring of recent runtime events in the store, read back by the status tool.
const diag = async ($: Dollar, line: string) => {
  const now = new Date(await $.clock.now()).toISOString().slice(11, 19)
  const old = ((await $.store.get('diag')) as string[] | undefined) ?? []
  await $.store.set('diag', [...old, `${now} ${line}`].slice(-60))
}

const finalize = async ($: Dollar, task: Cur, answer: string, ended: { durationMs: number; isAborted: boolean }, gen: number) => {
  await chain
  const now = await $.clock.now()
  const after = await $.session.usage().catch(() => null)
  const a5 = win(after?.rateLimits, 'five_hour')
  const moved = task.before !== undefined && a5 ? Math.max(0, +(a5.percentUsed - task.before).toFixed(1)) : undefined
  const entry: LedgerTask = { id: task.id, sid, title: short(task.title, 80), at: now, usd: task.usd, tokens: task.tokens, moved, io: task.io, cache: task.cache }
  await writeLedger($, now, after?.rateLimits, l => {
    delete l.live[sid]
    l.tasks = [...l.tasks.filter(t => t.id !== task.id), entry]
  })
  const snap = await refresh($)
  const s = await read($, settings)
  const existing = (await read($, reports)).find(r => r.id === task.id)
  const report: Report = {
    ...existing,
    id: task.id,
    n: existing?.n ?? (await read($, reports)).length + 1,
    title: short(task.title, 120),
    durationMs: task.durationMs,
    isAborted: ended.isAborted,
    tokens: task.tokens,
    io: task.io,
    cache: task.cache,
    usd: task.usd,
    windowBefore: task.before,
    windowAfter: a5?.percentUsed,
    tools: [...task.tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    rec: undefined,
    recState: s.recommend ? 'pending' : 'off',
  }
  await update($, reports, list => (existing ? list.map(r => (r.id === task.id ? report : r)) : [...list, report].slice(-40)))
  await statusLine($, snap, now)
  if (existing) {
    await diag($, `task ${task.id} resumed (turn ${task.turns}): ${fmt(task.tokens)} tok, $${task.usd.toFixed(3)}`)
  } else {
    const placed = await $.ui.place({ id: `task-${task.id}` })
    await diag($, `task ${task.id} done: ${fmt(task.tokens)} tok, $${task.usd.toFixed(3)}, rate ${snap.rate ?? 'none'} (${snap.samples} samples), card ${placed.isPlaced ? 'placed' : `not placed (${placed.reason})`}`)
    if (placed.requestId) await update($, reports, list => list.map(r => (r.id === task.id ? { ...r, requestId: placed.requestId } : r)))
  }
  if (ended.isAborted || (!s.celebrate && !s.recommend)) return
  $.clock.after(SETTLE_MS, () => void settled($, task, answer, gen).catch(() => undefined))
}

// Runs once the task has gone quiet: a later turn (a wake-up or a new prompt) makes this a no-op.
const settled = async ($: Dollar, task: Cur, answer: string, gen: number) => {
  if (gen !== settleGen || cur) return
  const s = await read($, settings)
  const r = (await read($, reports)).find(x => x.id === task.id)
  if (s.celebrate && !r?.celebrated) {
    const verdict = await judgeMilestone($, task, answer)
    await diag($, `milestone ${task.id}: ${verdict.celebrate ? 'yes' : 'no'} (${verdict.why})`)
    if (verdict.celebrate) {
      await update($, reports, l => l.map(x => (x.id === task.id ? { ...x, celebrated: true } : x)))
      await celebrate($, short(task.title, 60))
    }
  }
  if (s.recommend && gen === settleGen && !cur) await recommend($, task.id, answer, task.wrap)
}

// A task the user moved on from before it settled never gets a suggestion; drop its "thinking" line.
const dropPendingRec = ($: Dollar, id: string) =>
  update($, reports, l => l.map(x => (x.id === id && x.recState === 'pending' && !x.rec ? { ...x, recState: 'off' as const } : x)))

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

const MILESTONE_SYSTEM = `You decide whether a coding task that just finished deserves a celebration. Celebrate rarely: only when this task completed a whole piece of work the user will feel as "done".
YES: a feature or planned implementation was built end to end (e.g. the user approved a plan with "yes, build it" and it was built and tested); the last of a group of related fixes or polish requests, where this task confirms the group is now finished and nothing in it is left open (e.g. a final visual check that found and fixed the last mismatch).
NO: reviews and /code-review, investigations, questions and answers, plans or decisions, commits and pushes, applying review findings, a single bug fix (one QA report, one device concern) in the middle of ongoing work, a correction of the previous task, tooling or config changes, a task that ends asking the user to choose or approve before the work is done.
At most one celebration per group: if an earlier task of the same group was already celebrated, say NO unless this one finishes a new, separate piece of work.
Reply with JSON only: {"celebrate":true|false,"why":"<max 60 chars>"}`

// One cheap Haiku call over a digest of the task and the session's recent tasks; never celebrates a task that edited nothing.
const judgeMilestone = async ($: Dollar, task: Cur, answer: string): Promise<{ celebrate: boolean; why: string }> => {
  const edits = [...task.tools].filter(([n]) => EDIT_TOOLS.test(n)).reduce((n, [, c]) => n + c, 0)
  if (edits === 0) return { celebrate: false, why: 'no files changed' }
  const now = await $.clock.now()
  const earlier = (await read($, reports)).filter(r => r.id !== task.id).slice(-6)
  const prompt = [
    `Recent earlier tasks in this session, oldest first:`,
    ...(earlier.length ? earlier.map(r => `- "${short(oneLine(r.title), 140)}"${r.celebrated ? ' [celebrated]' : ''}`) : ['- none']),
    ``,
    `Task that just finished: "${short(oneLine(task.title), 400)}"`,
    task.plan.items.length ? `Its plan: ${task.plan.items.map(i => short(i, 60)).join(' | ')}` : '',
    task.wrap?.recap ? `Assistant recap: ${short(oneLine(task.wrap.recap), 300)}` : '',
    task.wrap?.ask ? `Assistant's closing question to the user: ${short(oneLine(task.wrap.ask), 120)}` : '',
    `Files edited: ${edits} edits. Tools: ${[...task.tools].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`).join(', ')}. Duration ${dur(now - task.startedAt)}.`,
    `Assistant's final message (trimmed): ${short(oneLine(answer), 500)}`,
  ]
    .filter(Boolean)
    .join('\n')
  const res = await $.model
    .complete({ model: 'haiku', system: MILESTONE_SYSTEM, prompt, maxTokens: 80, effort: 'low', timeoutMs: 15000 })
    .catch(() => null)
  if (!res || !res.isAnswered) return { celebrate: false, why: 'judge unavailable' }
  try {
    const j = JSON.parse(res.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { celebrate?: unknown; why?: unknown }
    return { celebrate: j.celebrate === true, why: short(oneLine(String(j.why ?? '')), 80) }
  } catch {
    return { celebrate: false, why: 'unparsed verdict' }
  }
}

const recommend = async ($: Dollar, id: string, answer: string, wrap?: { recap?: string; ask?: string }) => {
  const list = await read($, reports)
  const r = list.find(x => x.id === id)
  if (!r) return
  await update($, reports, l => l.map(x => (x.id === id ? { ...x, recState: 'pending' as const } : x)))
  const prompt = [
    `Task just finished: ${short(r.title, 240)}`,
    wrap?.recap ? `Assistant recap: ${short(wrap.recap, 160)}` : '',
    wrap?.ask ? `Assistant proposed next: ${short(wrap.ask, 100)}` : '',
    `Assistant's final message (trimmed): ${short(oneLine(answer), 400)}`,
    `Tools used: ${r.tools.slice(0, 4).map(t => `${t.name}×${t.count}`).join(', ') || 'none'}`,
  ]
    .filter(Boolean)
    .join('\n')
  const res = await $.model
    .complete({ model: 'haiku', system: REC_SYSTEM, prompt, maxTokens: 160, effort: 'low', timeoutMs: 15000 })
    .catch(async (err: unknown) => (await diag($, `rec ${id}: request refused: ${String(err).slice(0, 120)}`), null))
  let rec: Rec = quickRec(r)
  let ok = false
  if (res && res.isAnswered) {
    const m = res.text.match(/\{[\s\S]*\}/)
    try {
      const j = m ? (JSON.parse(m[0]) as Partial<Record<string, string>>) : {}
      const pick = MODELS.find(x => x.name.toLowerCase() === String(j.model ?? '').toLowerCase()) ?? MODELS.find(x => String(j.model ?? '').toLowerCase().includes((x.name.split(' ')[0] ?? '').toLowerCase()))
      if (j.task && pick) {
        rec = { task: short(oneLine(j.task), 140), model: pick.name, modelId: pick.id, effort: j.effort ?? 'medium', why: short(oneLine(j.why ?? ''), 120), source: 'ai' }
        ok = true
      }
    } catch {
      ok = false
    }
  }
  await update($, reports, l => l.map(x => (x.id === id ? { ...x, rec, recState: ok ? ('ready' as const) : ('failed' as const) } : x)))
  await diag($, `rec ${id}: ${res ? (res.isAnswered ? (ok ? 'ai ok' : `unparsed reply: ${oneLine(res.text).slice(0, 80)}`) : `no answer (${res.reason})`) : 'no result'} -> ${rec.model}: ${rec.task.slice(0, 60)}`)
  $.ui.toast(`➜ Next: ${short(rec.task, 70)} · ${rec.model}`, { timeoutMs: 8000 })
}

// The full-window fireworks ride the session theme's backdrop; cleared again when the party ends.
const showBackdrop = ($: Dollar) => $.theme.set({ backdrop: { id: BACKDROP, glass: { blur: 3, opacity: 0.35 } } })
const hideBackdrop = ($: Dollar) => $.theme.clear()

const celebrate = async ($: Dollar, title: string) => {
  const p: Party = { id: `${Date.now().toString(36)}`, title, at: await $.clock.now() }
  await update($, party, () => p)
  partyTimer?.cancel()
  const pane = await $.ui.open({ id: PANE, title: 'Abacus Aurora' }).catch(() => ({ isPlaced: false }))
  const bd = await showBackdrop($).catch((err: unknown) => ({ isDrawn: false as const, reason: String(err).slice(0, 120) }))
  const row = await $.ui.place({ id: `party-${p.id}` })
  await diag($, `party ${p.id}: pane ${pane.isPlaced ? 'shown' : 'not shown'}, backdrop ${bd.isDrawn ? 'drawn' : `not drawn (${'reason' in bd ? bd.reason : '?'})`}, card ${row.isPlaced ? 'placed' : `not placed (${row.reason})`}`)
  $.ui.toast(`🎆 Milestone: ${title}`)
  partyTimer = $.clock.after(PARTY_MS, () => {
    void hideBackdrop($).catch(() => undefined)
    void update($, party, () => null)
  })
  return { pane: pane.isPlaced, backdrop: bd.isDrawn, card: row.isPlaced }
}

const nextBlock = ($: Dollar, ui: ElementTable, r: Report) => {
  const { Box, Text, Button } = ui
  if (r.recState === 'off') return null
  const rec = r.rec
  if (!rec) return r.recState === 'pending' ? <Text dimColor>➜ Thinking about the next step…</Text> : null
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={C.next}>➜ </Text>
        <Text>{rec.task}</Text>
        <Text dimColor> · {rec.model}, {rec.effort}</Text>
      </Text>
      <Box gap={1}>
        <Button key={`use-${r.id}`} label="Use as prompt" onPress={() => $.prompt.fill({ text: rec.task })} />
        <Button
          key={`model-${r.id}`}
          label={`Switch to ${rec.model}`}
          onPress={async () => {
            await $.command.run({ command: 'model', args: rec.modelId }).catch(() => $.ui.toast(`Run /model ${rec.modelId}`))
          }}
        />
      </Box>
    </Box>
  )
}

// The card under each task: its share, then where the window stands.
const taskCard = async ($: Dollar, ui: ElementTable, rid: string) => {
  const { Box, Text, Button } = ui
  const r = (await read($, reports)).find(x => x.id === rid)
  if (!r || (await read($, dismissed)).includes(rid)) return null
  const snap = await read($, snapshot)
  const v = splitWindow(snap, sid, await $.clock.now())
  const row = v.rows.find(x => x.id === rid)
  const share = row?.share ?? (snap.rate !== undefined ? r.usd * snap.rate : undefined)
  const upper = r.windowBefore !== undefined && r.windowAfter !== undefined ? Math.max(0, r.windowAfter - r.windowBefore) : undefined
  const shareText = share !== undefined ? pct(share) : upper !== undefined ? `≤${pct(upper)}` : '—'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} marginTop={1}>
      <Box gap={1} justifyContent="space-between">
        <Text>
          <Text bold>🧮 Task {r.n}{r.isAborted ? ' (interrupted)' : ''} · </Text>
          <Text bold color={C.mine}>{shareText} of 5h</Text>
          <Text dimColor> · {fmt(r.io ?? r.tokens)} tokens in+out · {dur(r.durationMs)}</Text>
        </Text>
        <Button key={`hide-${rid}`} label="×" onPress={() => update($, dismissed, l => [...l.filter(x => x !== rid), rid].slice(-40))} />
      </Box>
      <Text dimColor>
        5h at {pct(v.total)}
        {v.mine !== undefined ? ` — this device ${pct(v.mine)} · other devices ${pct(v.other)}` : ' — calibrating the split'}
      </Text>
      {nextBlock($, ui, r)}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aurora',
      description: 'Abacus Aurora: 5-hour limit by device and task · /aurora party | next | recs on|off | fx on|off | reset',
      argumentHint: '[party|next|recs on|off|fx on|off|reset]',
    })
    await $.tool.register({ name: 'celebrate', description: 'Abacus Aurora: launch the fireworks celebration now and report whether the backdrop and card were drawn.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } })
    await $.tool.register({ name: 'status', description: 'Abacus Aurora: the 5-hour split (this device vs other devices, per task), calibration state and recent diagnostics.', inputSchema: { type: 'object' } })
    const result = await next(e)
    sid = await $.session.id()
    const u = await $.session.usage().catch(() => null)
    lastCost = u?.cost?.usd
    await writeLedger($, await $.clock.now(), u?.rateLimits, () => undefined).catch(() => undefined)
    await refresh($).catch(() => undefined)
    void poll($, true).catch(() => undefined)
    $.clock.every(20_000, async () => {
      const snap = await refresh($).catch(() => null)
      if (snap) await statusLine($, snap, await $.clock.now()).catch(() => undefined)
    })
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    return result
  })

  on('tool.call', { tool: 'mcp__abacus-aurora__celebrate' }, async ($, e) => {
    const title = typeof (e as unknown as { title?: unknown }).title === 'string' ? String((e as unknown as { title: string }).title) : 'Demo celebration'
    const r = await celebrate($, title)
    return { result: `pane open: ${r.pane}; full-window backdrop drawn: ${r.backdrop}; transcript card placed: ${r.card}; clears in ${PARTY_MS / 1000}s` }
  })

  on('tool.call', { tool: 'mcp__abacus-aurora__status' }, async $ => {
    const lines = ((await $.store.get('diag')) as string[] | undefined) ?? []
    const snap = await refresh($)
    const v = splitWindow(snap, sid, await $.clock.now())
    const last = (await read($, reports)).at(-1)
    await poll($, true).catch(() => undefined)
    const t = await read($, totals)
    const split = `5h ${pct(v.total)}: this device ${pct(v.mine)}, other devices ${pct(v.other)}; rate ${snap.rate ?? 'uncalibrated'} %/USD from ${snap.samples} samples; live poll: ${pollNote || 'not yet'}; session tokens in+out ${fmt(t.io)}, cache ${fmt(t.cache)}`
    const rows = v.rows.map(r => `${r.isLive ? 'running' : 'task'} ${r.isHere ? '(this session)' : '(other session)'} "${short(r.title, 50)}": ${pct(r.share)}`)
    const summary = last ? `last task #${last.n}: rec ${last.recState}${last.rec ? ` -> ${last.rec.model}: ${last.rec.task}` : ''}` : 'no task report in this session yet'
    return { result: [split, ...rows, summary, ...lines.slice(-20)].join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isFollowUp(e)) {
      hasNewPrompt = true
      lastPrompt = e.command ? `/${e.command.name}${e.command.args ? ` ${e.command.args}` : ''}` : e.text
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined || cur) return next(e)
    settleGen += 1
    const isNew = hasNewPrompt || !prev
    hasNewPrompt = false
    const before = await $.session.usage().catch(() => null)
    if (before?.cost?.usd !== undefined) lastCost = before.cost.usd
    if (!isNew && prev) {
      // A background result or engine notice: the same task carries on, under its own row.
      cur = prev
      cur.turns += 1
      lastLiveWrite = 0
      streaming.clear()
      return next(e)
    }
    if (prev) void dropPendingRec($, prev.id).catch(() => undefined)
    counter += 1
    const title = oneLine(lastPrompt)
    cur = {
      id: `${Date.now().toString(36)}${counter}`,
      title: title && !/^<[a-z-]+>/.test(title) ? title : 'Background result',
      turns: 1,
      durationMs: 0,
      startedAt: await $.clock.now(),
      before: win(before?.rateLimits, 'five_hour')?.percentUsed,
      usd: 0,
      tokens: 0,
      io: 0,
      cache: 0,
      tools: new Map(),
      plan: { len: 0, done: 0, wrapped: false, items: [] },
    }
    lastLiveWrite = 0
    streaming.clear()
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const key = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const stream = next(e)
    let chars = 0
    try {
      for await (const c of stream) {
        if (c.kind === 'text' || c.kind === 'thinking') chars += c.text.length
        else if (c.kind === 'input') chars += c.json.length
        if (cur) {
          streaming.set(key, chars)
          drawSoon($, await $.clock.now())
        }
        yield c
      }
    } finally {
      streaming.delete(key)
    }
    const r = await stream.result
    const u = r.usage
    if (u) {
      const task = cur
      if (task) {
        task.tokens += tokensOf(u)
        task.io += ioOf(u)
        task.cache += cacheOf(u)
      }
      void update($, totals, t => ({ io: t.io + ioOf(u), cache: t.cache + cacheOf(u) })).catch(() => undefined)
      void onStep($, u).catch(() => undefined)
    }
    return r
  })

  on('tool.call', ($, e, next) => {
    const task = cur
    if (task) {
      task.tools.set(e.tool, (task.tools.get(e.tool) ?? 0) + 1)
      const input = e as unknown as Record<string, unknown>
      if (/update_plan$/.test(e.tool)) {
        const items = input.items as { status?: string; content?: string }[] | undefined
        if (Array.isArray(items)) {
          task.plan.len = items.length
          task.plan.done = items.filter(i => i.status === 'completed').length
          task.plan.items = items.map(i => (typeof i.content === 'string' ? i.content : '')).filter(Boolean)
        } else if (input.advance === true) {
          task.plan.done = Math.min(task.plan.len, task.plan.done + 1)
        } else if (Array.isArray(input.done)) {
          task.plan.done = Math.min(task.plan.len, task.plan.done + (input.done as unknown[]).length)
        }
      } else if (/wrap_up$/.test(e.tool)) {
        task.plan.wrapped = true
        task.wrap = {
          recap: typeof input.recap === 'string' ? input.recap : undefined,
          ask: typeof input.ask === 'string' ? input.ask : undefined,
        }
      } else if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos = input.todos as { status?: string }[]
        task.plan.len = todos.length
        task.plan.done = todos.filter(t => t.status === 'completed').length
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !cur) return result
    const task = cur
    cur = null
    prev = task
    task.durationMs += e.durationMs
    const answer = e.answer
    const ended = { durationMs: e.durationMs, isAborted: e.isAborted }
    const gen = settleGen
    // One finalize at a time: a quick wake-up must find the row its own task already wrote.
    $.clock.after(0, () => {
      finals = finals.then(() => finalize($, task, answer, ended, gen)).catch(() => undefined)
    })
    return result
  })

  on('command.run', { command: 'aurora' }, async ($, e) => {
    const [verb, arg] = e.args.replace(/[\[\]<>]/g, ' ').trim().toLowerCase().split(/\s+/)
    if (verb === 'party') {
      await celebrate($, 'Manual celebration')
      return { text: '🎆 Fireworks launched.' }
    }
    if (verb === 'next') {
      const last = (await read($, reports)).at(-1)
      if (!last) return { text: 'No finished task yet.' }
      void recommend($, last.id, '', undefined)
      return { text: 'Re-thinking the next step on the last card…' }
    }
    if (verb === 'recs' || verb === 'fx') {
      const enable = arg !== 'off'
      await update($, settings, s => (verb === 'recs' ? { ...s, recommend: enable } : { ...s, celebrate: enable }))
      return { text: `${verb === 'recs' ? 'Next-task recommendations' : 'Celebrations'} ${enable ? 'on' : 'off'}.` }
    }
    if (verb === 'reset') {
      await $.store.delete('cal2')
      await $.store.delete('calib')
      await refresh($)
      return { text: 'Calibration reset; the per-device split re-learns over the next point of use.' }
    }
    await $.ui.open({ id: PANE, title: 'Abacus Aurora' })
    return { text: 'Abacus Aurora pane opened.' }
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.props.plugin !== P) return next(e)
    const p = await read($, party)
    if (!p) return next(e)
    const ui = $.ui.resolve(e)
    if (!('Svg' in ui)) return next(e)
    const { Svg } = ui
    return <Svg source={fireworks(p.at % 9973, 1600, 1000, 10, '3')} alt="Fireworks celebration" isInteractive />
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== P) return next(e)
    const id = e.props.id
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined

    if (id.startsWith('party-')) {
      const p = await read($, party)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="#f72585" paddingX={1}>
          {Svg ? <Svg source={fireworks(Number.parseInt(id.slice(6), 36) % 9973, 720, 160, 6, 'indefinite')} alt="Fireworks" width={720} height={160} isInteractive /> : null}
          <Box gap={1}>
            <Text bold color={C.next}>🎆 ✨ Milestone{p ? `: ${p.title}` : ''} ✨ 🎆</Text>
            <Button key={`again-${id}`} label="Again" onPress={() => celebrate($, p?.title ?? 'Encore')} />
          </Box>
        </Box>
      )
    }

    if (!id.startsWith('task-')) return next(e)
    const card = await taskCard($, ui, id.slice(5))
    return card ?? <Box />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const snap = await read($, snapshot)
    const s = await read($, settings)
    const p = await read($, party)
    const list = await read($, reports)
    const last = list.at(-1)
    const now = await $.clock.now()
    const v = splitWindow(snap, sid, now)
    const t = await read($, totals)
    const w = windowTokens(snap, now)
    const width = Math.max(160, Math.min(320, ((e.props as { bodyColumns?: number }).bodyColumns ?? 40) * 7))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 16)
    const legend = (color: string, label: string, value: string) => (
      <Text>
        <Text color={color}>● </Text>
        <Text dimColor>{label} </Text>
        <Text bold>{value}</Text>
      </Text>
    )
    const byId = new Map(list.map(r => [r.id, r]))
    return (
      <Box flexDirection="column" gap={1}>
        {p ? (
          <Box flexDirection="column" borderStyle="round" borderColor="#f72585">
            {Svg ? <Svg source={fireworks(p.at % 9973, 360, 220, 7, 'indefinite')} alt="Fireworks celebration" width={360} height={220} isInteractive /> : null}
            <Text bold color={C.next}>🎆 ✨ {p.title} ✨ 🎆</Text>
          </Box>
        ) : null}

        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>5-hour limit  {pct(v.total)}</Text>
            <Text dimColor>{clock(snap.ledger.reset) ? `resets ${clock(snap.ledger.reset)}` : ''}</Text>
          </Box>
          {Svg ? <Svg source={windowBar(v, width)} alt={`5-hour window ${pct(v.total)} used`} width={width} height={8} /> : <Text>{textBar(v, 30)}</Text>}
          {v.mine !== undefined ? (
            <Box gap={2} flexWrap="wrap">
              {legend(C.mine, 'This device', pct(v.mine))}
              {legend(C.other, 'Other devices', pct(v.other))}
            </Box>
          ) : (
            <Text dimColor>Learning this device's share — needs about {SPAN * 2}% of use.</Text>
          )}
          {snap.ledger.weekly !== undefined ? <Text dimColor>Weekly {pct(snap.ledger.weekly)}</Text> : null}
        </Box>

        <Box flexDirection="column">
          <Text bold>Tokens</Text>
          <Text>
            <Text dimColor>This session  </Text>
            <Text bold>{fmt(t.io)}</Text>
            <Text dimColor> in+out · </Text>
            <Text bold>{fmt(t.cache)}</Text>
            <Text dimColor> cache read+write</Text>
          </Text>
          <Text>
            <Text dimColor>This device, 5h  </Text>
            <Text bold>{fmt(w.io)}</Text>
            <Text dimColor> in+out · </Text>
            <Text bold>{fmt(w.cache)}</Text>
            <Text dimColor> cache</Text>
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>This device · {v.rows.length} {v.rows.length === 1 ? 'task' : 'tasks'}</Text>
          {v.rows.length === 0 ? <Text dimColor>No tasks in this window yet.</Text> : null}
          {v.rows.slice(0, room).map(r => {
            const rep = byId.get(r.id)
            return (
              <Button
                key={`row-${r.id}`}
                onPress={() => (rep?.requestId ? $.ui.scroll({ to: { requestId: rep.requestId } }).then(() => undefined) : undefined)}
              >
                <Text color={r.isLive ? C.accent : undefined}>{r.isLive ? '● ' : '  '}</Text>
                {short(r.title, 32)} <Text bold color={C.mine}>{pct(r.share)}</Text>
                {r.isHere ? '' : <Text dimColor> · other session</Text>}
              </Button>
            )
          })}
        </Box>

        {last ? nextBlock($, ui, last) : null}

        <Box gap={1} flexWrap="wrap">
          <Button key="recs" label={`Next-step ${s.recommend ? 'on' : 'off'}`} onPress={() => update($, settings, x => ({ ...x, recommend: !x.recommend }))} />
          <Button key="fx" label={`Fireworks ${s.celebrate ? 'on' : 'off'}`} onPress={() => update($, settings, x => ({ ...x, celebrate: !x.celebrate }))} />
        </Box>
      </Box>
    )
  })
}
