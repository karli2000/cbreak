// The setup flow (GitHub sign-in, nickname, rules) and every /cbreak subcommand except the bare one.
// The Controller owns the helper process and the break; it hands this class a narrow `SetupHost`.
// Pure: every side effect goes through the host and its Port. Runs in the mod environment.
import type { Api, ApiPath, ApiResult, AuthState } from '../../shared/protocol.ts'
import type { CoffeeCommand } from './commands.ts'
import { COPY, errorText } from './copy.ts'
import type { PaneView, Port, Timer } from './port.ts'
import { isRoomSlug, type SettingKey, type Settings } from './settings.ts'

const CHECK_DEBOUNCE_MS = 400
const MAX_LINES = 50
const NICK = /^[a-z0-9_-]{3,20}$/

/** Shared use of the running helper; release it exactly when done (extra calls are no-ops). */
export interface Lease {
  /** Latest auth state the helper reported. */
  auth(): AuthState
  call<P extends ApiPath>(path: P, body: Api[P]['req']): Promise<ApiResult<P>>
  release(): void
}

export interface SetupHost {
  readonly port: Port
  settings(): Settings
  /** Applies `s` at once; false when storing it failed. */
  saveSettings(s: Settings): Promise<boolean>
  onBreak(): boolean
  /** The running helper (break or setup), else a fresh one. null when none could start. */
  lease(): Promise<Lease | null>
  /** Starts a focused break if Claude is busy and breaks are allowed; adopts the leased helper. */
  startBreak(): Promise<void>
  /** Leaves a break or an attempt at one; resolves after the teardown. */
  endBreak(): Promise<void>
  closePane(): Promise<void>
  /** Opens or refocuses the shared pane; resolves with whether it is placed. */
  openPane(focus: boolean, title: string): Promise<boolean>
  /** Kicked or banned for the session; returns the `removed` text. */
  block(reason: string | null): string
  /** The answer when `lease()` gave null: COPY.needsBun without Bun, else COPY.helperUnavailable. */
  unavailable(): string
}

type Step = 'signin' | 'nick' | 'rules' | 'done'
type Subcommand = Exclude<CoffeeCommand, { kind: 'open' }>

const FIELD: Record<SettingKey, 'minBusySec' | 'graceSec' | 'autoOpen' | 'emoji' | 'bg' | 'text'> = {
  'min-wait': 'minBusySec',
  grace: 'graceSec',
  'auto-open': 'autoOpen',
  emoji: 'emoji',
  bg: 'bg',
  text: 'text',
}

function authLine(a: AuthState): string {
  switch (a.state) {
    case 'ready':
      return COPY.statusSignedIn(a.nickname, a.role)
    case 'signed_out':
      return COPY.notSignedIn
    case 'banned':
      return COPY.removed(a.ban_reason)
    default:
      return COPY.statusUnfinished
  }
}

export class Setup {
  /** Held from `/cbreak setup` until the setup is ready, banned, closed or its helper died. */
  private lease: Lease | null = null
  private shown = false
  private step: Step = 'done'
  private lines: string[] = []
  /** Live nickname feedback, drawn after the lines and replaced on each input. */
  private check: string | null = null
  private draft = ''
  private checkTimer: Timer | null = null
  private checkSeq = 0
  private loginUrl: string | null = null

  constructor(private host: SetupHost) {}

  /** The setup pane is up: from `/cbreak setup` until it is closed or a break takes the pane over. */
  showing(): boolean {
    return this.shown
  }

  /** Waiting for the person; automatic breaks hold off meanwhile. */
  running(): boolean {
    return this.lease !== null && this.step !== 'done'
  }

  async command(cmd: Subcommand): Promise<string> {
    switch (cmd.kind) {
      case 'setup':
        return this.start()
      case 'status':
        return this.status()
      case 'name':
        return this.name(cmd.nick)
      case 'room':
        return isRoomSlug(cmd.slug) ? this.save({ room: cmd.slug }, COPY.roomSet(cmd.slug)) : COPY.roomInvalid
      case 'config':
        return COPY.settingsLine(this.host.settings())
      case 'config_set':
        return this.save({ [FIELD[cmd.key]]: cmd.value }, COPY.saved)
      case 'on':
        return this.save({ enabled: true }, COPY.on)
      case 'off': {
        const text = await this.save({ enabled: false }, COPY.off)
        await this.host.endBreak()
        return text
      }
      case 'logout':
        return this.account('/logout', COPY.signedOut)
      case 'delete_account':
        return cmd.confirmed ? this.account('/delete-account', COPY.accountDeleted) : COPY.deleteWarn
      case 'invalid':
        return `${cmd.error}\n${COPY.commands}`
    }
  }

  // ---- setup pane ----

  /** The setup pane; the Controller adds the pane colors. */
  view(): Omit<Extract<PaneView, { mode: 'setup' }>, 'colors'> {
    return {
      mode: 'setup',
      lines: this.check ? [...this.lines, this.check] : this.lines.slice(),
      draft: this.draft,
      placeholder: COPY.setupPlaceholder[this.step],
    }
  }

  /** Awaited inside the `/cbreak` command hook, so the open answers the person and is placed; later
   *  calls (a new step) re-open the placed pane with a focus request. */
  async focus(): Promise<boolean> {
    this.shown = true
    return this.host.openPane(true, COPY.setupTitle)
  }

  input(value: string): void {
    this.draft = value
    if (this.step !== 'nick') return
    this.cancelCheck()
    const nick = value.trim().toLowerCase()
    this.check = nick && !NICK.test(nick) ? errorText('nickname_invalid') : null
    if (NICK.test(nick)) {
      const seq = this.checkSeq
      this.checkTimer = this.host.port.after(CHECK_DEBOUNCE_MS, () => {
        this.checkTimer = null
        void this.checkNick(nick, seq)
      })
    }
    this.host.port.redraw()
  }

  async submit(value: string): Promise<void> {
    this.draft = value
    const lease = this.lease
    if (this.step === 'done' || !lease) {
      this.close()
      return this.host.closePane()
    }
    switch (this.step) {
      case 'signin': {
        const r = await lease.call('/login', {}) // the URL arrives as a `login` event
        if (!r.ok) this.push(errorText(r.code))
        break
      }
      case 'nick': {
        const nick = value.trim().toLowerCase()
        this.cancelCheck()
        if (!NICK.test(nick)) {
          this.check = errorText('nickname_invalid')
          break
        }
        const r = await lease.call('/nickname/claim', { nick }) // success arrives as an `auth` event
        if (r.ok || this.step !== 'nick') break
        this.check = errorText(r.code)
        break
      }
      case 'rules': {
        if (value.trim().toLowerCase() !== 'yes') {
          this.draft = ''
          this.push(COPY.rules)
          break
        }
        const r = await lease.call('/rules/accept', {})
        if (!r.ok) this.push(errorText(r.code))
        break
      }
    }
    this.host.port.redraw()
  }

  /** The pane was closed (or the session ends): stop the setup and its helper. */
  close(): void {
    this.shown = false
    this.cancelCheck()
    this.step = 'done'
    const lease = this.lease
    this.lease = null
    lease?.release()
  }

  /** A break took the pane over. */
  dismiss(): void {
    this.shown = false
  }

  // ---- helper events (the Controller forwards them) ----

  onAuth(a: AuthState): void {
    if (!this.running()) return
    const before = this.step
    this.follow(a)
    // a step that needs typing, reached later (back from the browser sign-in, after the nickname):
    // ask for the keyboard again; the surface grants it only over an empty prompt
    if (this.step !== before && (this.step === 'nick' || this.step === 'rules')) void this.focus()
  }

  onLogin(url: string): void {
    if (!this.running() || this.step !== 'signin' || url === this.loginUrl) return
    this.loginUrl = url
    this.push(COPY.loginUrl(url))
    this.host.port.redraw()
  }

  onError(code: string): void {
    if (!this.running()) return
    this.push(errorText(code))
    this.host.port.redraw()
  }

  helperGone(): void {
    if (!this.lease) return
    this.lease = null
    this.cancelCheck()
    this.step = 'done'
    this.push(COPY.setupGone)
    this.host.port.redraw()
  }

  // ---- internals ----

  private async start(): Promise<string> {
    if (this.lease) {
      await this.focus()
      return COPY.setupOpening
    }
    const lease = await this.host.lease()
    if (!lease) return this.host.unavailable()
    const auth = lease.auth()
    if (auth.state === 'ready') {
      await this.host.startBreak()
      lease.release()
      return COPY.signedInAs(auth.nickname)
    }
    if (auth.state === 'banned' || this.lease) {
      lease.release()
      return auth.state === 'banned' ? this.host.block(auth.ban_reason) : COPY.setupOpening
    }
    this.lease = lease
    this.lines = []
    this.check = null
    this.draft = ''
    this.loginUrl = null
    this.step = 'done'
    this.follow(auth)
    await this.focus()
    return COPY.setupOpening
  }

  private follow(a: AuthState): void {
    switch (a.state) {
      case 'signed_out':
        this.enter('signin', COPY.signin)
        break
      case 'needs_nickname':
        this.enter('nick', COPY.pickNick)
        break
      case 'needs_rules':
        this.enter('rules', COPY.rules)
        break
      case 'ready':
        this.enter('done', COPY.ready(a.nickname, this.host.settings().minBusySec))
        void this.finish()
        break
      case 'banned':
        this.enter('done', this.host.block(a.ban_reason))
        void this.finish()
        break
    }
    this.host.port.redraw()
  }

  private enter(step: Step, text: string): void {
    if (step === this.step) return // the same state reported again
    this.step = step
    this.cancelCheck()
    this.check = null
    this.draft = ''
    this.push(text)
  }

  /** Ready or banned: a busy Claude gets its break (adopting the helper), then the lease ends. */
  private async finish(): Promise<void> {
    const lease = this.lease
    if (!lease) return
    await this.host.startBreak()
    if (this.lease === lease) this.lease = null
    lease.release()
  }

  private async checkNick(nick: string, seq: number): Promise<void> {
    const lease = this.lease
    if (!lease) return
    const r = await lease.call('/nickname/check', { nick })
    if (seq !== this.checkSeq || this.step !== 'nick') return
    this.check = r.ok ? (r.data.available ? COPY.available(nick) : COPY.taken(nick)) : errorText(r.code)
    this.host.port.redraw()
  }

  private cancelCheck(): void {
    this.checkTimer?.cancel()
    this.checkTimer = null
    this.checkSeq++
  }

  private push(text: string): void {
    this.lines.push(text)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  private async status(): Promise<string> {
    const lease = await this.host.lease()
    let who: string
    if (!lease) who = this.host.unavailable()
    else {
      try {
        const r = await lease.call('/status', {})
        who = authLine(r.ok ? r.data.auth : lease.auth())
      } finally {
        lease.release()
      }
    }
    return [who, COPY.settingsLine(this.host.settings()), COPY.onBreak(this.host.onBreak())].join('\n')
  }

  private async name(nick: string): Promise<string> {
    if (!NICK.test(nick)) return errorText('nickname_invalid')
    const lease = await this.host.lease()
    if (!lease) return this.host.unavailable()
    try {
      const r = await lease.call('/nickname/claim', { nick })
      return r.ok ? COPY.nameSet(nick) : errorText(r.code)
    } finally {
      lease.release()
    }
  }

  /** Logout and account deletion end a break first, so the room is left cleanly. */
  private async account(path: '/logout' | '/delete-account', done: string): Promise<string> {
    await this.host.endBreak()
    const lease = await this.host.lease()
    if (!lease) return this.host.unavailable()
    try {
      const r = await lease.call(path, {})
      if (r.ok || (path === '/logout' && r.code === 'not_signed_in')) return done
      return errorText(r.code)
    } finally {
      lease.release()
    }
  }

  private async save(patch: Partial<Settings>, done: string): Promise<string> {
    return (await this.host.saveSettings({ ...this.host.settings(), ...patch })) ? done : COPY.saveFailed
  }
}
