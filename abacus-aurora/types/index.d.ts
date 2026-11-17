export type ToolRow = { name: string; count: number }
export type Rec = {
  task: string
  model: string
  modelId: string
  effort: string
  why: string
  source: 'ai' | 'quick'
}
export type Report = {
  id: string
  n: number
  title: string
  durationMs: number
  isAborted: boolean
  tokens: number
  usd: number
  windowBefore?: number
  windowAfter?: number
  tools: ToolRow[]
  rec?: Rec
  recState: 'pending' | 'ready' | 'off' | 'failed'
  requestId?: string
  io?: number
  cache?: number
  celebrated?: boolean
}
// io = input + output tokens, cache = cache read + cache write tokens.
export type LedgerTask = { id: string; sid: string; title: string; at: number; usd: number; tokens: number; moved?: number; io?: number; cache?: number }
export type LedgerLive = { title: string; usd: number; tokens: number; at: number; io?: number; cache?: number }
export type Totals = { io: number; cache: number }
export type Ledger = {
  reset?: string
  pct?: number
  weekly?: number
  at?: number
  tasks: LedgerTask[]
  live: Record<string, LedgerLive>
}
// rate is the one in use: the fixed one when set (shared across devices), else learned.
// foreign = window points this device saw move while it spent nothing: a floor on other devices' share.
export type Snapshot = { ledger: Ledger; rate?: number; samples: number; learned?: number; isFixed?: boolean; isSuspect?: boolean; foreign?: number }
// Device-wide tracker of the window moving while this device is idle; usdAt = when this device last spent.
export type Foreign = { reset?: string; pct: number; lastP?: number; lastUsd?: number; lastAt?: number; usdAt?: number }
export type Party = { id: string; title: string; at: number }
export type Settings = { recommend: boolean; celebrate: boolean }

declare module 'claude-code' {
  interface PluginState {
    'abacus-aurora': {
      reports: Shaped<Report[]>
      snapshot: Shaped<Snapshot>
      party: Party | null
      settings: Settings
      dismissed: string[]
      totals: Totals
    }
  }
}
