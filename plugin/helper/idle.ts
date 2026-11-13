// Idle exit for cbreakd, aware of laptop sleep: after a suspend the wall clock jumps, and the
// first check would otherwise fire before the mod's overdue /ping arrives.

/** A gap between checks this many intervals long is a suspend (or a frozen process), not idle time. */
const SUSPEND_FACTOR = 3

export class IdleWatch {
  private last: number
  private lastCheck: number
  private idleExitMs: number
  private intervalMs: number
  private now: () => number

  constructor(o: { idleExitMs: number; intervalMs: number; now?: () => number }) {
    this.idleExitMs = o.idleExitMs
    this.intervalMs = o.intervalMs
    this.now = o.now ?? Date.now
    this.last = this.lastCheck = this.now()
  }

  /** A request arrived. */
  touch(): void {
    this.last = this.now()
  }

  /** Run every `intervalMs`; true once the helper has been idle for `idleExitMs`. */
  check(): boolean {
    const t = this.now()
    if (t - this.lastCheck > SUSPEND_FACTOR * this.intervalMs) this.last = t // woke up: give the mod a full period
    this.lastCheck = t
    return t - this.last >= this.idleExitMs
  }
}
