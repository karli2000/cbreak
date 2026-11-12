// Room session: join_room + the private Realtime channel, chat relay, presence, re-join, moderation calls.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage, HelperEvent, JoinInfo, Role } from '../shared/protocol'
import { CoffeeError, codeOf, rpc } from './rpc'

type Profile = { nickname: string; role: Role }

/** id → {nickname, role} from `public_profiles`, cached for the life of the process. */
export class NicknameCache {
  private byId = new Map<string, Profile>()

  constructor(private client: SupabaseClient) {}

  async names(ids: string[]): Promise<Map<string, Profile>> {
    const missing = [...new Set(ids)].filter((id) => !this.byId.has(id))
    if (missing.length) {
      const { data, error } = await this.client.from('public_profiles').select('id, nickname, role').in('id', missing)
      if (error) throw new CoffeeError(codeOf(error), error.message)
      for (const p of (data ?? []) as ({ id: string } & Profile)[]) this.byId.set(p.id, { nickname: p.nickname, role: p.role })
    }
    const out = new Map<string, Profile>()
    for (const id of ids) {
      const p = this.byId.get(id)
      if (p) out.set(id, p)
    }
    return out
  }

  /** The user id for a nickname (case-insensitive: the column is citext). Throws CoffeeError('not_found'). */
  async idOf(nickname: string): Promise<string> {
    const { data, error } = await this.client
      .from('public_profiles')
      .select('id, nickname, role')
      .eq('nickname', nickname)
      .maybeSingle()
    if (error) throw new CoffeeError(codeOf(error), error.message)
    if (!data) throw new CoffeeError('not_found')
    const p = data as { id: string } & Profile
    this.byId.set(p.id, { nickname: p.nickname, role: p.role })
    return p.id
  }
}

/** Re-subscribe delays in seconds after consecutive channel failures; the last one repeats. */
const BACKOFF_S = [1, 2, 4, 8, 16, 30]
/** Consecutive failures after which the mod is told Realtime is unavailable. */
const UNAVAILABLE_AFTER = 3
const BACKLOG_LIMIT = 100

type Deps = { client: SupabaseClient; emit: (e: HelperEvent) => void; userId: string; cache: NicknameCache }

export class RoomSession {
  private client: SupabaseClient
  private emit: (e: HelperEvent) => void
  readonly userId: string
  private cache: NicknameCache

  private info: JoinInfo | null = null
  private channel: RealtimeChannel | null = null
  /** Bumped on every room change (attach, leave, kick); a stale join or retry compares against it. */
  private roomGen = 0
  /** Bumped whenever the channel is replaced or dropped; callbacks of an old channel compare against it. */
  private chanGen = 0
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Live events held back until the backlog has been emitted. */
  private pending: HelperEvent[] | null = null
  private rejoining: Promise<JoinInfo> | null = null

  constructor(deps: Deps) {
    this.client = deps.client
    this.emit = deps.emit
    this.userId = deps.userId
    this.cache = deps.cache
  }

  current(): JoinInfo | null {
    return this.info
  }

  /** join_room, then subscribe to the instance's channel; emits `joined`, then `backlog`. */
  async join(room: string): Promise<JoinInfo> {
    const info = await rpc<JoinInfo>(this.client, 'join_room', { room_slug: room })
    await this.attach(info)
    return info
  }

  /** Keeps the occupancy row live; re-joins, leaves or drops the room depending on the answer. */
  async heartbeat(): Promise<void> {
    const info = this.info
    if (!info) return
    const gen = this.roomGen
    let hb: JoinInfo
    try {
      hb = await rpc<JoinInfo>(this.client, 'heartbeat')
    } catch (e) {
      if (gen !== this.roomGen) return
      const code = codeOf(e)
      if (code === 'not_in_room') await this.rejoin(info.room).catch((err) => this.onRejoinFailed(err))
      else if (code === 'room_closed' || code === 'banned') await this.onRejoinFailed(e)
      else if (code !== 'network') this.emitError(e)
      return
    }
    if (gen !== this.roomGen || !this.info) return
    if (hb.topic !== this.info.topic) await this.attach(hb) // our row was moved (e.g. joined from elsewhere)
    else this.info = { ...this.info, here: hb.here }
  }

  /** Never throws: leave_room errors are ignored. */
  async leave(): Promise<void> {
    this.drop()
    await rpc(this.client, 'leave_room').catch(() => {})
  }

  /** Forgets the room locally (channel, retries, `current()`) without calling the backend. */
  drop(): void {
    this.detach()
    this.info = null
    this.failures = 0
  }

  async send(body: string): Promise<{ id: number }> {
    try {
      return await this.sendOnce(body)
    } catch (e) {
      const room = this.info?.room
      if (codeOf(e) !== 'not_in_room' || !room) throw e
      try {
        await this.rejoin(room)
      } catch (err) {
        await this.onRejoinFailed(err)
        throw err
      }
      return this.sendOnce(body)
    }
  }

  async report(nickname: string, messageId: number | null, reason: string): Promise<{ report_id: number }> {
    const id = await rpc<number>(this.client, 'report_user', { target_nickname: nickname, message_id: messageId, reason })
    return { report_id: Number(id) }
  }

  async modDelete(messageId: number, reason: string): Promise<void> {
    await rpc(this.client, 'mod_delete_message', { message_id: messageId, reason })
  }

  async modMute(nickname: string, minutes: 10 | 60 | 1440, reason: string): Promise<void> {
    const target = await this.cache.idOf(nickname)
    await rpc(this.client, 'mod_mute', { target, minutes, reason })
  }

  async modBan(nickname: string, reason: string): Promise<void> {
    const target = await this.cache.idOf(nickname)
    await rpc(this.client, 'mod_ban', { target, reason })
  }

  // --- internals ---

  private async sendOnce(body: string): Promise<{ id: number }> {
    const row = await rpc<{ id: number }>(this.client, 'send_message', { body })
    return { id: row.id }
  }

  /** One re-join at a time (heartbeat, send and the reconnect loop may all hit not_in_room). */
  private rejoin(room: string): Promise<JoinInfo> {
    this.rejoining ??= this.join(room).finally(() => (this.rejoining = null))
    return this.rejoining
  }

  /**
   * The room can no longer be (re)joined: `room_closed` → room_closed event + leave, `banned` → like kicked,
   * `network` → keep the room (the next tick retries), anything else (e.g. `not_found`) → one error + leave.
   * Runs at most once per room: every branch except network clears `info` synchronously.
   */
  private async onRejoinFailed(e: unknown): Promise<void> {
    if (!this.info) return
    const code = codeOf(e)
    if (code === 'network') return
    if (code === 'banned') return this.onKicked()
    if (code === 'room_closed') this.emit({ type: 'room_closed' })
    else this.emitError(e)
    await this.leave()
  }

  private emitError(e: unknown) {
    this.emit({ type: 'error', code: codeOf(e), ...(e instanceof Error && e.message !== codeOf(e) ? { message: e.message } : {}) })
  }

  /** Switches to `info`'s topic: new channel, first subscribe, then `joined` and `backlog`. */
  private async attach(info: JoinInfo): Promise<void> {
    this.detach()
    this.info = info
    // `failures` survives a re-join, so the first successful subscribe of a streak still emits `online`
    const gen = this.roomGen
    this.pending = []
    // a failed first subscribe starts the reconnect loop; joined and backlog are emitted either way
    await this.subscribe(info.topic)
    if (gen !== this.roomGen) return
    this.emit({ type: 'joined', ...info })
    let messages: ChatMessage[] = []
    try {
      messages = await this.loadBacklog(info)
    } catch (e) {
      this.emitError(e)
    }
    if (gen !== this.roomGen) return
    this.emit({ type: 'backlog', messages })
    const held = this.pending ?? []
    this.pending = null
    const seen = new Set(messages.map((m) => m.id))
    for (const e of held) if (!(e.type === 'message' && seen.has(e.id))) this.emit(e)
  }

  /** Leaves the current room locally: drops the channel, any pending retry and held events. */
  private detach() {
    this.roomGen++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.pending = null
    this.dropChannel()
  }

  /** Removes the channel; callbacks of the old channel become no-ops. */
  private dropChannel() {
    this.chanGen++
    const ch = this.channel
    this.channel = null
    if (ch) void this.client.removeChannel(ch).catch(() => {})
  }

  /** Emits live events, or holds them while the backlog is loading. */
  private relay(gen: number, e: HelperEvent) {
    if (gen !== this.chanGen) return
    if (this.pending) this.pending.push(e)
    else this.emit(e)
  }

  /** Creates and subscribes the channel; resolves after the first status (success or failure). */
  private subscribe(topic: string): Promise<void> {
    this.dropChannel()
    const gen = this.chanGen
    const ch = this.client.channel(topic, { config: { private: true, presence: { key: this.userId } } })
    this.channel = ch
    ch.on('broadcast', { event: 'message' }, ({ payload }) => {
      const p = payload as ChatMessage
      this.relay(gen, {
        type: 'message',
        id: p.id,
        user_id: p.user_id,
        nickname: p.nickname,
        body: p.body,
        created_at: p.created_at,
        ...(p.role ? { role: p.role } : {}),
      })
    })
    ch.on('broadcast', { event: 'deleted' }, ({ payload }) => this.relay(gen, { type: 'deleted', id: (payload as { id: number }).id }))
    ch.on('broadcast', { event: 'kicked' }, ({ payload }) => {
      if (gen === this.chanGen && (payload as { user_id?: string }).user_id === this.userId) void this.onKicked()
    })
    ch.on('presence', { event: 'join' }, ({ key }) => void this.presence(gen, ch, key, 'joined'))
    ch.on('presence', { event: 'leave' }, ({ key }) => void this.presence(gen, ch, key, 'left'))

    return new Promise<void>((resolve) => {
      let first = true
      const settle = () => {
        if (first) {
          first = false
          resolve()
        }
      }
      ch.subscribe((status) => {
        if (gen !== this.chanGen) return settle()
        if (status === 'SUBSCRIBED') {
          if (this.failures > 0) this.emit({ type: 'connection', state: 'online' })
          this.failures = 0
          void ch.track({}).catch(() => {})
        } else this.onChannelFailure(gen)
        settle()
      })
    })
  }

  private async presence(gen: number, ch: RealtimeChannel, key: string, kind: 'joined' | 'left') {
    if (gen !== this.chanGen) return
    let names: string[] = []
    if (key !== this.userId) {
      try {
        const n = (await this.cache.names([key])).get(key)
        if (n) names = [n.nickname]
      } catch {}
    }
    if (gen !== this.chanGen) return
    const here = Object.keys(ch.presenceState()).length
    this.emit({ type: 'presence', here, joined: kind === 'joined' ? names : [], left: kind === 'left' ? names : [] })
  }

  /** CHANNEL_ERROR / TIMED_OUT / CLOSED while joined: heartbeat, then re-subscribe with backoff. */
  private onChannelFailure(gen: number) {
    if (gen !== this.chanGen || !this.info) return
    this.failures++
    if (this.failures === 1) this.emit({ type: 'connection', state: 'reconnecting' })
    if (this.failures === UNAVAILABLE_AFTER) this.emit({ type: 'error', code: 'realtime_unavailable' })
    // drop the failed channel (its callbacks become no-ops) but keep the room and held events
    this.dropChannel()
    const retryGen = this.roomGen
    const delayS = BACKOFF_S[Math.min(this.failures - 1, BACKOFF_S.length - 1)]!
    this.retryTimer = setTimeout(() => void this.retry(retryGen), delayS * 1000)
  }

  private async retry(gen: number) {
    this.retryTimer = null
    if (gen !== this.roomGen || !this.info) return
    await this.heartbeat() // may re-join, leave or move us to another topic (each a new roomGen)
    if (gen !== this.roomGen || !this.info) return
    await this.subscribe(this.info.topic)
  }

  /** `kicked` for me or `banned` from heartbeat: read the reason, drop the room, keep the process. */
  private async onKicked() {
    if (!this.info) return
    this.detach()
    this.info = null
    this.failures = 0
    let reason: string | null = null
    try {
      reason = (await rpc<{ ban_reason: string | null }>(this.client, 'my_profile')).ban_reason ?? null
    } catch {}
    this.emit({ type: 'kicked', reason })
  }

  private async loadBacklog(info: JoinInfo): Promise<ChatMessage[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('id, user_id, nickname, body, created_at')
      .eq('room', info.room)
      .eq('instance', info.instance)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(BACKLOG_LIMIT)
    if (error) throw new CoffeeError(codeOf(error), error.message)
    const rows = ((data ?? []) as ChatMessage[]).reverse()
    const roles = await this.cache.names(rows.flatMap((m) => (m.user_id ? [m.user_id] : []))).catch(() => new Map<string, Profile>())
    return rows.map((m) => {
      const p = m.user_id ? roles.get(m.user_id) : undefined
      return p ? { ...m, role: p.role } : m
    })
  }
}
