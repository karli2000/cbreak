// The mod's brain: break lifecycle, chat and the helper process. The setup flow and the /coffee
// subcommands live in setup.ts (`Setup`), which reaches back through a narrow `SetupHost`.
// Pure: every side effect goes through `Port`, the only timers are `Port.after`. Runs in the mod
// environment (no Node, no DOM). It never sees prompt text: turn hooks pass no arguments.
import type { Api, ApiPath, ApiResult, AuthState, ChatMessage, HelperEvent, JoinInfo } from '../../shared/protocol.ts'
import { parseCoffeeArgs, parsePaneInput, type PaneCommand } from './commands.ts'
import { COPY, errorText } from './copy.ts'
import { isAction, nickColor, segments } from './format.ts'
import type { Line, PaneView, Port, Timer } from './port.ts'
import { DEFAULTS, type Settings } from './settings.ts'
import { Setup, type Lease } from './setup.ts'

export type { Line, PaneView, Port, Timer } from './port.ts'

const HELLO_TIMEOUT_MS = 10_000
const PING_MS = 20_000
/** A helper call that has not answered by then counts as `network` (a hung call must not wedge the teardown queue). */
const CALL_TIMEOUT_MS = 15_000
const MAX_LINES = 200

type Phase = 'idle' | 'pending' | 'joining' | 'break' | 'grace' | 'left'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * One spawned coffeebreakd (at most one at a time). `hello`/`auth` settle with null when it is stopped
 * or exits. It is stopped once neither a break (`breakHeld`) nor a command lease (`holds`) uses it.
 */
type Helper = {
  socket: string | null
  alive: boolean
  hello: Deferred<string | null>
  /** Settles with the first auth event; `state` keeps the latest. */
  auth: Deferred<AuthState | null>
  state: AuthState | null
  holds: number
  breakHeld: boolean
  /** The /join call of this helper, if one was issued. Settled before any /leave (ruling R5). */
  join: Promise<unknown> | null
  ping: Timer | null
}

export class Controller {
  private settings: Settings = { ...DEFAULTS }
  private settingsReady: Promise<void>
  private busy = false
  private phase: Phase = 'idle'
  /** Bumped whenever a break attempt is abandoned or ended; stale continuations compare against it. */
  private gen = 0
  /** Teardowns run here in order; a new break waits for it, so helpers never overlap. */
  private lifecycle: Promise<void> = Promise.resolve()
  private helper: Helper | null = null
  private auth: AuthState | null = null
  private join: JoinInfo | null = null
  private lines: Line[] = []
  private draft = ''
  private manual = false
  private placed = false
  /** The coffee pane is open (chat or setup), as far as this Controller asked for it. */
  private paneOpen = false
  private pendingTimer: Timer | null = null
  private graceTimer: Timer | null = null
  private graceExpired = false
  private draftKeptShown = false
  private closePending = false
  private setupHinted = false
  /** A `reconnecting` line was shown and no `online` followed yet. */
  private reconnecting = false
  /** Kicked or banned: no joins for the rest of the session. */
  private removed: string | null = null
  private ended = false
  private setup: Setup

  constructor(private port: Port) {
    this.settingsReady = port.loadSettings().then(
      (s) => void (this.settings = s),
      () => {},
    )
    this.setup = new Setup({
      port,
      settings: () => this.settings,
      saveSettings: (s) => this.saveSettings(s),
      onBreak: () => this.inRoom(),
      lease: () => this.lease(),
      startBreak: () => this.manualBreak(),
      endBreak: () => this.endBreak(),
      closePane: () => this.closePane(),
      openPane: (focus, title) => this.openPane(focus, title),
      block: (reason) => this.block(reason),
    })
  }

  // ---- Claude Code events ----

  turnStart(): void {
    this.busy = true
    if (!this.settings.enabled || this.removed !== null || this.ended) return
    switch (this.phase) {
      case 'idle': // not `left`: closing the pane holds off until a turn completes
        this.phase = 'pending'
        this.pendingTimer = this.port.after(this.settings.minBusySec * 1000, () => {
          this.pendingTimer = null
          if (this.phase === 'pending') void this.startBreak(false)
        })
        return
      case 'grace':
        this.cancelGrace()
        this.phase = 'break'
        this.addLine(COPY.busyAgain)
        this.port.redraw()
        return
    }
  }

  turnComplete(_aborted: boolean): void {
    this.busy = false
    switch (this.phase) {
      case 'pending':
        this.cancelPending()
        this.phase = 'idle'
        return
      case 'joining':
        void this.end('idle', { leave: true, close: this.paneOpen })
        return
      case 'break':
        this.phase = 'grace'
        this.addLine(COPY.done)
        this.graceTimer = this.port.after(this.settings.graceSec * 1000, () => {
          this.graceTimer = null
          this.graceExpired = true
          this.checkGrace()
        })
        this.port.redraw()
        return
      case 'left':
        this.phase = 'idle'
        return
    }
  }

  /** After Esc a close is refused until the next input (spike S1), so it is retried here. */
  promptSubmitted(): void {
    if (this.closePending) void this.closePane()
  }

  sessionEnd(): void {
    this.ended = true
    this.setup.close()
    this.cancelPending()
    void this.end('idle', { leave: true, close: false })
  }

  paneClosedByPerson(): void {
    this.placed = false
    this.paneOpen = false
    this.closePending = false
    this.setup.close()
    if (this.inRoom() || this.phase === 'joining') void this.end(this.busy ? 'left' : 'idle', { leave: true, close: false })
  }

  // ---- pane ----

  input(value: string): void {
    if (this.setup.showing()) return this.setup.input(value)
    this.draft = value
    if (!value.trim()) this.checkGrace()
  }

  async submit(value: string): Promise<void> {
    if (this.setup.showing()) return this.setup.submit(value)
    this.draft = value
    if (!value.trim()) return
    const cmd = parsePaneInput(value)
    switch (cmd.kind) {
      case 'invalid':
        this.addLine(cmd.error)
        break
      case 'help':
        this.clearDraft(value)
        this.addLine(COPY.paneHelp(this.isStaff()))
        break
      case 'leave':
        this.clearDraft(value)
        if (this.inRoom() || this.phase === 'joining') await this.end(this.busy ? 'left' : 'idle', { leave: true, close: true })
        else await this.closePane()
        break
      default:
        await this.roomCommand(cmd, value)
    }
    this.port.redraw()
    this.checkGrace()
  }

  /** `/coffee <args>`: the bare command opens the room; `Setup` handles the others. */
  async command(args: string): Promise<string> {
    await this.settingsReady
    const cmd = parseCoffeeArgs(args)
    return cmd.kind === 'open' ? await this.open() : this.setup.command(cmd)
  }

  view(): PaneView {
    if (this.setup.showing()) return this.setup.view()
    const j = this.join
    return {
      mode: 'chat',
      header: COPY.title(j?.room ?? this.settings.room, j?.here ?? 0),
      busy: this.busy,
      lines: this.lines.slice(),
      draft: this.draft,
      inputEnabled: this.inRoom() && !!this.helper?.socket,
    }
  }

  // ---- break lifecycle ----

  /**
   * The bare `/coffee`. The pane is opened (focused) before this resolves, so the open answers the
   * person's command and is placed at any width; an open made later counts as unasked (below 144
   * columns it would wait undrawn).
   */
  private async open(): Promise<string> {
    if (!this.busy) return COPY.idle // exactly, even when removed (ruling R9)
    if (this.removed !== null) return this.removed
    if (!this.settings.enabled) return COPY.off
    if (this.setup.running()) {
      await this.setup.focus()
      return COPY.setupRunning
    }
    if (this.inRoom()) await this.showPane(true)
    else await this.manualStart()
    return COPY.opening
  }

  /** A break the setup asks for once it is ready, if Claude is still busy (or already joining). */
  private async manualBreak(): Promise<void> {
    if (!this.busy || !this.settings.enabled || this.removed !== null || this.ended || this.inRoom()) return
    await this.manualStart()
  }

  /**
   * Starts a focused break (or marks a running attempt as the person's) and opens the pane at once
   * with a `joining` line; the join fills it later. Resolves once the pane is open.
   */
  private async manualStart(): Promise<void> {
    if (this.phase === 'joining') this.manual = true
    else void this.startBreak(true) // runs synchronously up to its first await: phase is `joining` now
    if (this.phase !== 'joining') return // the setup starts it once ready, or breaks are off
    if (!this.lines.some((l) => l.kind === 'system' && l.text === COPY.joining)) this.addLine(COPY.joining)
    await this.openPane(true, this.title())
  }

  /** Ends a break or an attempt at one (/coffee off, logout, delete-account); resolves after the teardown. */
  private endBreak(): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'left') return this.lifecycle
    return this.end(this.busy ? 'left' : 'idle', { leave: true, close: this.inRoom() || this.paneOpen })
  }

  private async startBreak(manual: boolean): Promise<void> {
    if (this.phase === 'joining' || this.inRoom()) return
    this.cancelPending()
    if (this.setup.running()) return void (this.phase = 'idle') // the setup starts the break once ready
    const gen = ++this.gen
    this.phase = 'joining'
    this.manual = manual
    this.lines = []
    this.reconnecting = false
    this.join = null
    this.placed = false
    this.draftKeptShown = false
    await Promise.all([this.lifecycle, this.settingsReady])
    if (gen !== this.gen) return
    if (!this.settings.enabled) return void (this.phase = 'idle')

    const h = this.helper ?? this.spawn() // a command's helper is adopted, never a second one
    h.breakHeld = true
    await h.hello.promise
    if (gen !== this.gen) return
    if (!h.socket) return this.fail(h, COPY.helperGone)

    await h.auth.promise
    if (gen !== this.gen) return
    const auth = h.alive ? h.state : null
    if (!auth) return this.fail(h, COPY.helperGone)
    if (auth.state === 'banned') {
      const text = this.block(auth.ban_reason)
      this.port.toast(text) // the pane is not open yet
      return this.fail(h, text)
    }
    if (auth.state !== 'ready') {
      if (this.manual || !this.setupHinted) this.port.toast(COPY.setupHint)
      this.setupHinted = true
      return this.fail(h, null)
    }

    const join = this.call(h, '/join', { room: this.settings.room })
    h.join = join
    const res = await join
    if (gen !== this.gen) return // whoever ended the break leaves now that the join has settled
    if (!res.ok) {
      const text = res.code === 'banned' ? this.block(null) : errorText(res.code)
      this.port.toast(text)
      return this.fail(h, text)
    }
    this.join ??= res.data
    this.phase = 'break'
    this.lines = this.lines.filter((l) => !(l.kind === 'system' && l.text === COPY.joining))
    this.setup.dismiss()
    this.port.redraw()
    if (!this.manual && !this.settings.autoOpen && !this.paneOpen) return this.port.status(COPY.statusHint(this.here()))
    await this.showPane(this.manual, true)
  }

  /** Gives up a break attempt before the room was joined. */
  private fail(h: Helper, line: string | null): void {
    h.breakHeld = false
    this.maybeStop(h)
    this.phase = 'idle'
    this.port.status(undefined)
    if (line) this.addLine(line)
    this.port.redraw()
    if (this.paneOpen && this.manual) {
      // the pane /coffee opened early closes again; the other failures already toast
      if (line === COPY.helperGone) this.port.toast(line)
      void this.closePane()
    }
  }

  private block(reason: string | null): string {
    this.removed = COPY.removed(reason)
    return this.removed
  }

  /** Opens or refocuses the pane; with `reuse`, a pane already placed is left as it is (the Port retitles it). */
  private async showPane(focus: boolean, reuse = false): Promise<void> {
    const gen = this.gen
    if (!(reuse && this.paneOpen && this.placed)) {
      await this.openPane(focus, this.title())
      if (gen !== this.gen) return
    }
    if (this.placed) {
      this.port.status(COPY.status(this.here()))
      this.port.scrollToEnd()
    } else {
      this.port.toast(COPY.statusHint(this.here()))
      this.port.status(COPY.statusHint(this.here()))
    }
  }

  /**
   * Ends the break (or an attempt at one) now: phase, timers and status change synchronously.
   * The helper teardown is queued: it waits for an in-flight /join before /leave (ruling R5).
   */
  private end(next: 'idle' | 'left', o: { leave: boolean; close: boolean }): Promise<void> {
    this.gen++
    this.cancelPending()
    this.cancelGrace()
    this.phase = next
    this.port.status(undefined)
    this.port.redraw()
    const h = this.helper
    this.lifecycle = this.lifecycle
      .then(async () => {
        if (h) {
          if (h.join) await h.join
          if (o.leave && h.join && h.alive) await this.call(h, '/leave', {})
          h.join = null
          h.breakHeld = false
          this.maybeStop(h) // a command still holding it stops it when done
        }
        if (o.close) await this.closePane()
      })
      .catch(() => {})
    return this.lifecycle
  }

  private checkGrace(): void {
    if (this.phase !== 'grace' || this.busy || !this.graceExpired) return
    if (this.draft.trim()) {
      if (!this.draftKeptShown) {
        this.draftKeptShown = true
        this.addLine(COPY.draftKept)
        this.port.redraw()
      }
      return
    }
    void this.end('idle', { leave: true, close: true })
  }

  private async saveSettings(s: Settings): Promise<boolean> {
    this.settings = s // applies for this session even if storing fails
    try {
      await this.port.saveSettings(s)
      return true
    } catch {
      return false
    }
  }

  /** Every pane open goes through here (chat and setup), so `paneOpen`/`placed` stay true. */
  private async openPane(focus: boolean, title: string): Promise<boolean> {
    let placed = false
    try {
      placed = (await this.port.openPane(focus, title)).placed
    } catch {}
    this.paneOpen = true
    this.closePending = false
    this.placed = placed
    return placed
  }

  private async closePane(): Promise<void> {
    let ok = false
    try {
      ok = await this.port.closePane()
    } catch {}
    this.closePending = !ok
    this.placed = false
    if (ok) this.paneOpen = false
  }

  private cancelPending(): void {
    this.pendingTimer?.cancel()
    this.pendingTimer = null
  }

  private cancelGrace(): void {
    this.graceTimer?.cancel()
    this.graceTimer = null
    this.graceExpired = false
    this.draftKeptShown = false
  }

  // ---- helper process ----

  /**
   * A helper for a command: the running one (break or setup) if any, else a fresh one, which is
   * stopped on release unless a break adopted it meanwhile. null when it did not start.
   */
  private async lease(): Promise<Lease | null> {
    if (!this.helper) await this.lifecycle // a queued teardown stops its helper first
    const h = this.helper ?? this.spawn()
    h.holds++
    let held = true
    const release = () => {
      if (!held) return
      held = false
      h.holds--
      this.maybeStop(h)
    }
    await h.hello.promise
    if (h.socket) await h.auth.promise
    const first = h.state
    if (!h.socket || !h.alive || !first) {
      release()
      return null
    }
    return { auth: () => h.state ?? first, call: (path, body) => this.call(h, path, body), release }
  }

  private spawn(): Helper {
    const h: Helper = {
      socket: null,
      alive: true,
      hello: deferred(),
      auth: deferred(),
      state: null,
      holds: 0,
      breakHeld: false,
      join: null,
      ping: null,
    }
    this.helper = h
    this.port.spawnHelper(
      (e) => {
        if (this.helper === h) this.onEvent(h, e)
      },
      () => this.onExit(h),
    )
    const timeout = this.port.after(HELLO_TIMEOUT_MS, () => h.hello.resolve(null))
    void h.hello.promise.then(() => timeout.cancel())
    return h
  }

  private maybeStop(h: Helper): void {
    if (h.holds === 0 && !h.breakHeld) this.stopHelper(h)
  }

  private stopHelper(h: Helper): void {
    h.ping?.cancel()
    h.hello.resolve(null)
    h.auth.resolve(null)
    if (this.helper === h) this.helper = null
    if (h.alive) {
      h.alive = false
      this.port.stopHelper()
    }
  }

  private onExit(h: Helper): void {
    if (!h.alive) return // we stopped it
    h.alive = false
    h.ping?.cancel()
    h.hello.resolve(null)
    h.auth.resolve(null)
    if (this.helper !== h) return
    this.helper = null
    if (h.holds > 0) this.setup.helperGone()
    if (this.phase !== 'joining' && !this.inRoom()) return
    this.addLine(COPY.helperGone)
    void this.end(this.phase === 'joining' || !this.busy ? 'idle' : 'left', { leave: false, close: false })
  }

  private schedulePing(h: Helper): void {
    h.ping = this.port.after(PING_MS, () => {
      if (!h.alive) return
      void this.call(h, '/ping', {})
      this.schedulePing(h)
    })
  }

  /** Never throws; a failed or hung call (no answer within CALL_TIMEOUT_MS) is `network`. */
  private async call<P extends ApiPath>(h: Helper, path: P, body: Api[P]['req']): Promise<ApiResult<P>> {
    if (!h.socket) return { ok: false, code: 'network' }
    const network: ApiResult<P> = { ok: false, code: 'network' }
    let timer: Timer | null = null
    const timeout = new Promise<ApiResult<P>>((resolve) => {
      timer = this.port.after(CALL_TIMEOUT_MS, () => resolve(network))
    })
    const answer = this.port.call(h.socket, path, body).catch(() => network)
    try {
      return await Promise.race([answer, timeout])
    } finally {
      ;(timer as Timer | null)?.cancel()
    }
  }

  private onEvent(h: Helper, e: HelperEvent): void {
    switch (e.type) {
      case 'hello':
        if (h.socket) return
        h.socket = e.socket
        h.hello.resolve(e.socket)
        this.schedulePing(h)
        return
      case 'auth': {
        const { type: _type, ...rest } = e
        const state = rest as AuthState
        this.auth = state
        h.state = state
        h.auth.resolve(state)
        this.setup.onAuth(state)
        return
      }
      case 'login':
        this.setup.onLogin(e.url)
        return
      case 'joined': {
        const prev = this.join
        this.join = { room: e.room, instance: e.instance, topic: e.topic, here: e.here }
        if (prev && (prev.room !== e.room || prev.instance !== e.instance)) this.addLine(COPY.moved(e.room, e.instance))
        this.updateStatus()
        break
      }
      case 'backlog':
        for (const m of e.messages) if (!this.lines.some((l) => l.kind === 'message' && l.id === m.id)) this.pushLine(this.messageLine(m))
        break
      case 'message':
        this.pushLine(this.messageLine(e))
        break
      case 'deleted':
        this.lines = this.lines.filter((l) => l.kind !== 'message' || l.id !== e.id)
        break
      case 'presence':
        if (this.join) this.join = { ...this.join, here: e.here }
        for (const n of e.joined) this.addLine(COPY.joined(n))
        for (const n of e.left) this.addLine(COPY.left(n))
        this.updateStatus()
        break
      case 'kicked':
        this.addLine(this.block(e.reason))
        void this.end(this.busy ? 'left' : 'idle', { leave: false, close: false })
        return
      case 'room_closed':
        this.addLine(errorText('room_closed'))
        void this.end('idle', { leave: true, close: true })
        return
      case 'room_lost':
        // the helper already left: keep the pane with the reason, no auto re-join in this turn
        if (!this.inRoom()) return
        this.addErrorLine(this.err(e.code))
        void this.end(this.busy ? 'left' : 'idle', { leave: false, close: false })
        return
      case 'connection':
        if (e.state === 'reconnecting') {
          this.reconnecting = true
          this.addLine(COPY.reconnecting)
        } else if (this.reconnecting) {
          this.reconnecting = false
          this.addLine(COPY.reconnected)
        }
        break
      case 'error':
        if (this.setup.running()) return this.setup.onError(e.code)
        this.addErrorLine(this.err(e.code))
        break
    }
    this.port.redraw()
  }

  // ---- chat ----

  private async roomCommand(cmd: Exclude<PaneCommand, { kind: 'invalid' | 'help' | 'leave' }>, value: string): Promise<void> {
    const h = this.helper
    if (!h?.socket || !this.inRoom()) return this.addLine(COPY.notInRoom)
    if ((cmd.kind === 'del' || cmd.kind === 'mute' || cmd.kind === 'ban') && !this.isStaff()) return this.addLine(errorText('forbidden'))
    let res: ApiResult<ApiPath>
    let done: string | null = null
    switch (cmd.kind) {
      case 'say':
      case 'me':
        res = await this.call(h, '/send', { body: cmd.kind === 'me' ? `/me ${cmd.body}` : cmd.body })
        if (res.ok) this.port.scrollToEnd()
        break
      case 'report':
        res = await this.call(h, '/report', { nickname: cmd.nickname, message_id: this.newestBy(cmd.nickname), reason: cmd.reason })
        done = COPY.reported(cmd.nickname)
        break
      case 'del': {
        const id = this.newestBy(cmd.nickname)
        if (id === null) return this.addLine(errorText('not_found'))
        res = await this.call(h, '/mod/delete', { message_id: id, reason: cmd.reason ?? '' })
        break
      }
      case 'mute':
        res = await this.call(h, '/mod/mute', { nickname: cmd.nickname, minutes: cmd.minutes, reason: cmd.reason })
        done = COPY.muted(cmd.nickname, cmd.minutes)
        break
      case 'ban':
        res = await this.call(h, '/mod/ban', { nickname: cmd.nickname, reason: cmd.reason })
        done = COPY.banned(cmd.nickname)
        break
    }
    if (!res.ok) return this.addLine(this.err(res.code))
    this.clearDraft(value)
    if (done) this.addLine(done)
  }

  /** Id of the newest message line by `nick`, or null. */
  private newestBy(nick: string): number | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]!
      if (l.kind === 'message' && l.nickname.toLowerCase() === nick) return l.id
    }
    return null
  }

  private messageLine(m: ChatMessage): Line {
    const action = isAction(m.body)
    const me = this.auth?.state === 'ready' ? this.auth.nickname : null
    return {
      kind: 'message',
      id: m.id,
      nickname: m.nickname,
      color: nickColor(m.nickname),
      action,
      segments: segments(action ? m.body.slice(4) : m.body, me),
      ...(m.role ? { role: m.role } : {}),
    }
  }

  // ---- small helpers ----

  private addLine(text: string): void {
    this.pushLine({ kind: 'system', text })
  }

  /** Like addLine, but a helper error repeating the line just above is not added again. */
  private addErrorLine(text: string): void {
    const last = this.lines[this.lines.length - 1]
    if (last?.kind === 'system' && last.text === text) return
    this.addLine(text)
  }

  private pushLine(l: Line): void {
    this.lines.push(l)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  private clearDraft(submitted: string): void {
    if (this.draft === submitted) this.draft = ''
  }

  private err(code: string): string {
    return errorText(code, { mutedUntil: this.auth?.state === 'ready' ? this.auth.muted_until : null })
  }

  private isStaff(): boolean {
    return this.auth?.state === 'ready' && this.auth.role !== 'user'
  }

  private inRoom(): boolean {
    return this.phase === 'break' || this.phase === 'grace'
  }

  private here(): number {
    return this.join?.here ?? 0
  }

  private title(): string {
    return COPY.title(this.join?.room ?? this.settings.room, this.here())
  }

  private updateStatus(): void {
    if (!this.inRoom()) return
    this.port.status(this.placed ? COPY.status(this.here()) : COPY.statusHint(this.here()))
  }
}
