import { expect, mock, test } from 'claude-code/testing'

import { calibrate, isFollowUp, isRateSuspect, parseRate, parseUsage, rateOf, splitWindow, windowTokens } from '../hooks/register'

const RESET = '2030-01-01T05:00:00.000Z'
const usage = (model: string, input: number, output: number) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

// One device: runs tasks that cost the given USD while the account-wide window reads the given percents.
const device = async ($: any, on: any, sessionId: string, tasks: { title: string; usd: number; windowAfter: number; wake?: boolean }[]) => {
  const clock = mock.clock(on, { now: 1_000 })
  // Calibrated at 1% of the 5-hour window per API-equivalent dollar.
  mock.store(on, { cal2: { anchor: -1, prev: -1, acc: 0, exact: false, lastAt: 0, samples: [1, 1, 1, 1] } })
  const live = { cost: 0, pct: 0, stepUsd: 0, windowAfter: 0 }
  const placed: string[] = []
  const asks = { model: 0 }
  on('command.register', () => ({ value: { command: 'aurora' } }))
  on('tool.register', () => ({ value: {} }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('prompt.submit', () => ({ text: '' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 300_000, percent: 30 },
      rateLimits: [{ kind: 'five_hour', percentUsed: live.pct, resetsAt: RESET }, { kind: 'seven_day', percentUsed: 41 }],
      cost: { usd: live.cost },
    },
  }))
  on('ui.place', (_: unknown, e: any) => (placed.push(e.id), { value: { isPlaced: true, requestId: `req-${e.id}` } }))
  on('theme.set', () => ({ value: { isDrawn: true, requestId: 'backdrop' } }))
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'cleared' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* (_: unknown, e: any) {
    live.cost += live.stepUsd
    live.stepUsd = 0
    live.pct = live.windowAfter
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage('claude-opus-5-5', 1000, 500) }
  })
  on('model.complete', () => (asks.model++, {
    value: { isAnswered: true, text: '{"task":"Commit and push","model":"Haiku 5.5","effort":"low","why":"git"}', usage: usage('claude-haiku-5-5', 10, 10) },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [i, t] of tasks.entries()) {
    await $.prompt.submit((t.wake ? { text: `<task-notification> ${t.title}`, origin: { kind: 'task-notification' } } : { text: t.title }) as never)
    await $.turn.start({ turnId: `t${i}` } as never)
    live.stepUsd = t.usd
    live.windowAfter = t.windowAfter
    for await (const _ of $.turn.step({ turnId: `t${i}`, index: 0, model: 'opus', messageCount: 1 } as never)) void _
    await clock.settle()
    await $.turn.complete({ turnId: `t${i}`, answer: 'Done.', durationMs: 60_000, isAborted: false, reason: 'answer' } as never)
    await clock.settle()
  }
  // Past the settle delay, so the last task's next-step and milestone have run.
  await clock.advance(30_000)
  return { placed, clock, live, asks }
}

const mountPane = ($: any) =>
  $.ui.mount({
    plugin: 'abacus-aurora', surface: 'desktop', component: 'Pane', requestId: 'aurora',
    props: { title: 'Abacus Aurora', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)

test('device 1 sees the 15% window, its own 12% as two tasks (7% + 5%) and 3% from other devices', async ($, on) => {
  // Device 2 spent 3% first, so the window already reads 10% when device 1's 7% task ends.
  const { placed } = await device($, on, 'sA', [
    { title: 'Redesign the pane', usd: 7, windowAfter: 10 },
    { title: 'Accurate task share', usd: 5, windowAfter: 15 },
  ])
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /5-hour limit\s+15\.0%/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^12\.0%$/ }))?.text).toBe('12.0%')
  expect((await pane.find({ type: 'Text', text: /^3\.0%$/ }))?.text).toBe('3.0%')
  expect(await pane.find({ type: 'Text', text: /^7\.0%$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^5\.0%$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2 tasks/ })).toBeDefined()
  await pane.unmount()

  const second = placed.filter(id => id.startsWith('task-'))[1] ?? ''
  const card = await $.ui.mount({ plugin: 'abacus-aurora', surface: 'terminal', component: 'Placed', requestId: `req-${second}`, props: { id: second, plugin: 'abacus-aurora' } } as never)
  expect(await card.find({ type: 'Text', text: /^5\.0% of 5h$/ })).toBeDefined()
  expect(await card.find({ type: 'Text', text: /this device 12\.0% · other devices 3\.0%/ })).toBeDefined()
  expect(await card.find({ type: 'Text', text: /Commit and push/ })).toBeDefined()
  await card.unmount()
})

test('device 2 sees the same 15% window with only its own 3% task; the other 12% is other devices', async ($, on) => {
  const { live, clock } = await device($, on, 'sB', [{ title: 'Second device task', usd: 3, windowAfter: 3 }])
  // Device 1 keeps working; device 2's next API reading is 15%.
  live.windowAfter = 15
  for await (const _ of $.turn.step({ turnId: 'probe', index: 0, model: 'opus', messageCount: 1, agentId: 'x' } as never)) void _
  await clock.settle()
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /5-hour limit\s+15\.0%/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^3\.0%$/ }))?.text).toBe('3.0%')
  expect((await pane.find({ type: 'Text', text: /^12\.0%$/ }))?.text).toBe('12.0%')
  expect(await pane.find({ type: 'Text', text: /1 task\b/ })).toBeDefined()
  await pane.unmount()
})

test('calibration ignores the inflation other devices add to a span', () => {
  // Device spends $1 per point; spans where another device also ran read higher.
  let cal = { anchor: -1, prev: -1, acc: 0, exact: false, lastAt: 0, samples: [] as number[] }
  let pct = 0
  let t = 0
  const readings = [1, 1, 3, 1, 1, 2.5, 1, 1, 1, 4]
  cal = calibrate(cal, 0, { kind: 'five_hour', percentUsed: 0, resetsAt: RESET }, t)
  for (const moved of readings) {
    for (let k = 0; k < 9; k++) cal = calibrate(cal, 0.1, { kind: 'five_hour', percentUsed: pct, resetsAt: RESET }, (t += 1000))
    pct = +(pct + moved).toFixed(1)
    cal = calibrate(cal, 0.1, { kind: 'five_hour', percentUsed: pct, resetsAt: RESET }, (t += 1000))
  }
  expect(cal.samples.length).toBe(10)
  expect(+(rateOf(cal.samples) ?? NaN).toFixed(4)).toBe(1)
})

test("an idle gap breaks the span so others' use while this device waits is never learned", () => {
  let cal = { anchor: -1, prev: -1, acc: 0, exact: false, lastAt: 0, samples: [] as number[] }
  cal = calibrate(cal, 0, { kind: 'five_hour', percentUsed: 0, resetsAt: RESET }, 0)
  cal = calibrate(cal, 0.5, { kind: 'five_hour', percentUsed: 0.5, resetsAt: RESET }, 1000)
  // 20 idle minutes, other devices move the window 6 points.
  cal = calibrate(cal, 0.5, { kind: 'five_hour', percentUsed: 7, resetsAt: RESET }, 1000 + 20 * 60_000)
  expect(cal.samples.length).toBe(0)
})

test('this device can never own more than the window', () => {
  const v = splitWindow(
    { rate: 2, samples: 4, ledger: { reset: RESET, pct: 15, tasks: [{ id: 'a', sid: 's', title: 'A', at: 1, usd: 6, tokens: 1 }, { id: 'b', sid: 's', title: 'B', at: 2, usd: 4, tokens: 1 }], live: {} } },
    's',
    1_000,
  )
  expect(+(v.mine ?? NaN).toFixed(4)).toBe(15)
  expect(+(v.other ?? NaN).toFixed(4)).toBe(0)
  expect(v.rows.map(r => +(r.share ?? 0).toFixed(2))).toEqual([6, 9])
})

test('the usage endpoint reads as percent windows with their resets', () => {
  const limits = parseUsage(JSON.stringify({ five_hour: { utilization: 4.0, resets_at: RESET }, seven_day: { utilization: 41.26, resets_at: null }, seven_day_opus: null }))
  expect(limits).toEqual([{ kind: 'five_hour', percentUsed: 4, resetsAt: RESET }, { kind: 'seven_day', percentUsed: 41.3 }])
  expect(parseUsage(JSON.stringify({ five_hour: { utilization: null } }))).toEqual([])
})

test('a window that has reset reads 0, not the last figure seen', () => {
  const snap = { rate: 1, samples: 4, ledger: { reset: '2000-01-01T00:00:00.000Z', pct: 58, tasks: [{ id: 'a', sid: 's', title: 'A', at: 1, usd: 6, tokens: 1, io: 10, cache: 20 }], live: {} } }
  const v = splitWindow(snap, 's', Date.parse('2001-01-01T00:00:00.000Z'))
  expect(v.total).toBe(0)
  expect(v.mine).toBe(0)
  expect(windowTokens(snap, Date.parse('2001-01-01T00:00:00.000Z'))).toEqual({ io: 0, cache: 0 })
})

test("this device's window tokens add finished and running tasks, in+out apart from cache", () => {
  const snap = {
    samples: 0,
    ledger: { reset: RESET, pct: 10, tasks: [{ id: 'a', sid: 's', title: 'A', at: 1, usd: 1, tokens: 1, io: 100, cache: 1000 }, { id: 'old', sid: 's', title: 'Old', at: 1, usd: 1, tokens: 5 }], live: { s2: { title: 'B', usd: 1, tokens: 1, io: 50, cache: 500, at: 900 } } },
  }
  expect(windowTokens(snap, 1_000)).toEqual({ io: 150, cache: 1500 })
})

test('background wake-ups carry on the task they belong to: one row, one card, its total cost', async ($, on) => {
  const { placed } = await device($, on, 'sW', [
    { title: 'Confirm no more localisation', usd: 4, windowAfter: 4 },
    { title: 'translator 1 done', usd: 2, windowAfter: 6, wake: true },
    { title: 'translator 2 done', usd: 3, windowAfter: 9, wake: true },
  ])
  expect(placed.filter(id => id.startsWith('task-')).length).toBe(1)
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /1 task\b/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^9\.0%$/ }))?.text).toBe('9.0%')
  expect(await pane.find({ type: 'Text', text: /task-notification/ })).toBeUndefined()
  await pane.unmount()
})

test('a burst of wake-ups asks Haiku for the next step once, after the task settles', async ($, on) => {
  const { asks } = await device($, on, 'sR', [
    { title: 'Run the full suite', usd: 1, windowAfter: 1 },
    { title: 'build done', usd: 1, windowAfter: 2, wake: true },
    { title: 'tests done', usd: 1, windowAfter: 3, wake: true },
  ])
  // No files were edited, so the milestone judge never asks; one next-step call for the whole task.
  expect(asks.model).toBe(1)
})

test('only prompts the user gave start a task', () => {
  expect(isFollowUp({ text: 'Fix the crash' })).toBe(false)
  expect(isFollowUp({ text: '/aurora party', origin: { kind: 'composer' } })).toBe(false)
  expect(isFollowUp({ text: 'done', origin: { kind: 'task-notification' } })).toBe(true)
  expect(isFollowUp({ text: '<task-notification> <task-id>b1</task-id>' })).toBe(true)
  expect(isFollowUp({ text: 'idle', isMeta: true })).toBe(true)
})

test("with one shared rate, each device's own share is the other's other-devices share", () => {
  const task = (id: string, usd: number) => ({ id, sid: 's', title: id, at: 1, usd, tokens: 1 })
  // Mac spent $16, the other device $4; at 1.84 %/$ the window reads 36.8%.
  const ledgerOf = (usd: number) => ({ reset: RESET, pct: 36.8, tasks: [task('t', usd)], live: {} })
  const mac = splitWindow({ rate: 1.84, samples: 20, ledger: ledgerOf(16) }, 's', 1_000)
  const other = splitWindow({ rate: 1.84, samples: 20, ledger: ledgerOf(4) }, 's', 1_000)
  expect(+(mac.mine ?? NaN).toFixed(2)).toBe(29.44)
  expect(+(other.other ?? NaN).toFixed(2)).toBe(29.44)
  expect(+(other.mine ?? NaN).toFixed(2)).toBe(7.36)
  expect(+(mac.other ?? NaN).toFixed(2)).toBe(7.36)
})

test('a fixed rate wins over the learned one until set back to auto', async ($, on) => {
  const { clock } = await device($, on, 'sF', [{ title: 'Work', usd: 4, windowAfter: 10 }])
  const run = (args: string) => $.command.run({ command: 'aurora', args } as never) as Promise<{ text: string }>
  expect((await run('rate 2')).text).toMatch(/fixed at 2 /)
  await clock.advance(20_000)
  let pane = await mountPane($)
  expect((await pane.find({ type: 'Text', text: /^8\.0%$/ }))?.text).toBe('8.0%')
  expect(await pane.find({ type: 'Text', text: /Rate 2\.000 %\/\$ \(fixed\)/ })).toBeDefined()
  await pane.unmount()
  expect((await run('rate auto')).text).toMatch(/auto/)
  await clock.advance(20_000)
  pane = await mountPane($)
  expect((await pane.find({ type: 'Text', text: /^4\.0%$/ }))?.text).toBe('4.0%')
  expect(await pane.find({ type: 'Text', text: /\(learned, 4 samples\)/ })).toBeDefined()
  await pane.unmount()
  expect((await run('rate nonsense')).text).toMatch(/Rate auto/)
})

test('a rate learned mostly while other devices ran is flagged; a clean one is not', () => {
  // This Mac's real samples on 2026-11-12: a tight cluster near 1.9 with a few contaminated spans.
  const mac = [1.8, 1.98, 2.03, 2.38, 2.31, 1.12, 9.93, 2.07, 1.81, 1.59, 2.92, 1.92, 2.12, 1.85, 1.9, 1.7, 3.94, 2.05, 2.13, 5.27]
  expect(isRateSuspect(mac)).toBe(false)
  // A light device whose spans mostly overlap the heavy one's work.
  expect(isRateSuspect([1.9, 2.1, 3.5, 4.2, 5, 4.8, 6.1, 3.9, 4.4, 7.2])).toBe(true)
  expect(isRateSuspect([9, 9, 9])).toBe(false)
})

test('the rate command takes a positive figure or auto', () => {
  expect(parseRate('1.84')).toBe(1.84)
  expect(parseRate('auto')).toBe('auto')
  expect(parseRate('0')).toBeUndefined()
  expect(parseRate(undefined)).toBeUndefined()
  expect(parseRate('x')).toBeUndefined()
})
