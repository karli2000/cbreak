// Fake Port for Controller tests: records every side effect, answers helper calls from a table,
// and runs `after` timers on a manual clock.
import type { Api, ApiPath, ApiResult, HelperEvent } from '../../plugin/shared/protocol.ts'
import type { Port, Timer } from '../../plugin/hooks/lib/controller.ts'
import { DEFAULTS, type Settings } from '../../plugin/hooks/lib/settings.ts'

type Answer<P extends ApiPath> = ApiResult<P> | ((body: Api[P]['req']) => ApiResult<P> | Promise<ApiResult<P>>)
type ExitInfo = { code: number | null; signal: string | null; stderr: string }

/** Lets every pending microtask (fake call answers, controller continuations) run. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export class FakePort implements Port {
  now = 0
  spawns = 0
  stops = 0
  calls: { path: ApiPath; body: unknown }[] = []
  opens: { focus: boolean; title: string }[] = []
  closes = 0
  statuses: (string | undefined)[] = []
  toasts: string[] = []
  redraws = 0
  scrolls = 0
  closeResult = true
  placed = true
  settings: Settings = { ...DEFAULTS }
  saved: Settings[] = []
  alive = false
  /** The adapter finds no Bun: each spawn reports `error no_bun` and exits without starting (ruling R2). */
  noBun = false
  /** What `agentsBusy()` answers (subagents still working). */
  agents = false

  private onEvent: ((e: HelperEvent) => void) | null = null
  private onExit: ((info: ExitInfo) => void) | null = null
  private answers = new Map<ApiPath, Answer<any>>()
  private timers: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = []
  private seq = 0

  spawnHelper(onEvent: (e: HelperEvent) => void, onExit: (info: ExitInfo) => void): void {
    this.spawns++
    this.onEvent = onEvent
    this.onExit = onExit
    if (this.noBun) {
      void Promise.resolve().then(() => {
        onEvent({ type: 'error', code: 'no_bun' })
        onExit({ code: null, signal: null, stderr: 'no_bun' })
      })
      return
    }
    this.alive = true
  }

  stopHelper(): void {
    this.stops++
    this.alive = false
  }

  /** Emits an event from the fake helper (the latest spawned one). */
  emit(e: HelperEvent): void {
    if (!this.onEvent) throw new Error('no helper spawned')
    this.onEvent(e)
  }

  /** The fake helper exits on its own. */
  exit(code: number | null = 1): void {
    this.alive = false
    this.onExit?.({ code, signal: null, stderr: 'boom' })
  }

  answer<P extends ApiPath>(path: P, a: Answer<P>): void {
    this.answers.set(path, a)
  }

  /** The next calls to `path` stay pending until the returned function is called. */
  hold<P extends ApiPath>(path: P): () => void {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const prev = this.answers.get(path)
    this.answers.set(path, async (body: unknown) => {
      await gate
      return this.resolve(path, prev, body)
    })
    return release
  }

  async call<P extends ApiPath>(_socket: string, path: P, body: Api[P]['req']): Promise<ApiResult<P>> {
    this.calls.push({ path, body })
    return this.resolve(path, this.answers.get(path), body)
  }

  private async resolve(path: ApiPath, a: Answer<any> | undefined, body: any): Promise<ApiResult<any>> {
    if (typeof a === 'function') return a(body)
    if (a) return a
    switch (path) {
      case '/join':
        return { ok: true, data: { room: body.room, instance: 1, topic: `room:${body.room}:1`, here: 1 } }
      case '/send':
        return { ok: true, data: { id: 1 } }
      case '/report':
        return { ok: true, data: { report_id: 1 } }
      default:
        return { ok: true, data: {} }
    }
  }

  paths(): ApiPath[] {
    return this.calls.map((c) => c.path)
  }

  count(path: ApiPath): number {
    return this.calls.filter((c) => c.path === path).length
  }

  async openPane(focus: boolean, title: string): Promise<{ placed: boolean }> {
    this.opens.push({ focus, title })
    return { placed: this.placed }
  }

  async closePane(): Promise<boolean> {
    this.closes++
    return this.closeResult
  }

  redraw(): void {
    this.redraws++
  }

  scrollToEnd(): void {
    this.scrolls++
  }

  status(text: string | undefined): void {
    this.statuses.push(text)
  }

  get lastStatus(): string | undefined {
    return this.statuses[this.statuses.length - 1]
  }

  toast(text: string): void {
    this.toasts.push(text)
  }

  after(ms: number, fn: () => void): Timer {
    const t = { at: this.now + ms, seq: this.seq++, fn, cancelled: false }
    this.timers.push(t)
    return { cancel: () => void (t.cancelled = true) }
  }

  /** Moves the clock forward, firing due timers in order (including ones scheduled while advancing). */
  advance(ms: number): void {
    const end = this.now + ms
    while (true) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      due.cancelled = true
      this.now = due.at
      due.fn()
    }
    this.timers = this.timers.filter((t) => !t.cancelled)
    this.now = end
  }

  async agentsBusy(): Promise<boolean> {
    return this.agents
  }

  async loadSettings(): Promise<Settings> {
    return { ...this.settings }
  }

  async saveSettings(s: Settings): Promise<void> {
    this.settings = { ...s }
    this.saved.push({ ...s })
  }
}
