import type { SupabaseClient } from '@supabase/supabase-js'
import type { Api, ApiPath, HelperEvent } from '../shared/protocol'
import { AuthStore, authState, ensureFreshSession, peekSession } from './auth'
import { openBrowser, startLogin } from './login'
import { NicknameCache, RoomSession } from './room'
import { CoffeeError, codeOf, rpc } from './rpc'

export type Emit = (e: HelperEvent) => void

export type Ctx = {
  client: SupabaseClient
  store: AuthStore
  emit: Emit
  /** Created by the first room route; dropped on logout/delete-account. */
  room: RoomSession | null
  touch(): void
  /** Refresh margin in seconds for ensureFreshSession. */
  marginS: number
  /** Whether a session was present at the last check; route handlers that sign out reset it. */
  signedIn: boolean
  /** The login in flight, if any; a second /login returns its URL. */
  login?: Promise<{ url: string }> | null
}

type Handler<P extends ApiPath> = (ctx: Ctx, req: Api[P]['req']) => Promise<Api[P]['res']>
export type Routes = { [P in ApiPath]?: Handler<P> }

/** Routes that work without a session. */
export const SIGNED_OUT_OK: ReadonlySet<string> = new Set(['/ping', '/status', '/login'])

/** Calls the github-age Edge Function once; failures are ignored (email test users get 400). */
export async function fetchGithubAge(client: SupabaseClient): Promise<void> {
  try {
    await client.functions.invoke('github-age')
  } catch {}
}

/** Once a profile is ready (rules accepted, not banned) without a github_created_at, calls github-age; errors ignored. */
export async function fetchGithubAgeIfNeeded(client: SupabaseClient): Promise<void> {
  try {
    const p = await rpc<{ rules_accepted_at: string | null; github_created_at: string | null; banned_at: string | null }>(client, 'my_profile')
    if (p.rules_accepted_at && !p.banned_at && !p.github_created_at) await fetchGithubAge(client)
  } catch {}
}

const LOGIN_TIMEOUT_MS = 5 * 60_000
const LOGIN_KEEPALIVE_MS = 10_000

/** Starts a login (or returns the pending one). The helper stays alive until it settles. */
function beginLogin(ctx: Ctx): Promise<{ url: string }> {
  // the promise is stored before any await, so concurrent /login calls share one flow
  if (ctx.login) return ctx.login
  const pending: Promise<{ url: string }> = (async () => {
    const { url, done } = await startLogin(ctx.client, { open: openBrowser, timeoutMs: LOGIN_TIMEOUT_MS })
    const keepAlive = setInterval(() => ctx.touch(), LOGIN_KEEPALIVE_MS)
    ctx.emit({ type: 'login', url })
    done
      .then(async (session) => {
        await ctx.store.write(session)
        ctx.signedIn = true
        await emitAuth(ctx)
        await fetchGithubAgeIfNeeded(ctx.client)
      })
      .catch((e) => ctx.emit({ type: 'error', code: 'login_failed', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        clearInterval(keepAlive)
        ctx.touch()
        if (ctx.login === pending) ctx.login = null
      })
    return { url }
  })()
  ctx.login = pending
  pending.catch(() => {
    if (ctx.login === pending) ctx.login = null
  })
  return pending
}

/** Emits the current auth state; a transient failure is reported as an error event instead. */
export async function emitAuth(ctx: Pick<Ctx, 'client' | 'emit'>): Promise<void> {
  try {
    ctx.emit({ type: 'auth', ...(await authState(ctx.client)) })
  } catch (e) {
    ctx.emit({ type: 'error', code: codeOf(e) })
  }
}

/** Best effort: a failing leave must never block logout or account deletion. */
async function leaveIfJoined(ctx: Ctx): Promise<void> {
  const room = ctx.room
  ctx.room = null
  if (room) await room.leave().catch(() => {})
}

/** The room session for the signed-in user, created on first use. */
async function roomOf(ctx: Ctx): Promise<RoomSession> {
  const session = await peekSession(ctx.client)
  if (!session) throw new CoffeeError('not_signed_in')
  if (ctx.room?.userId === session.user.id) return ctx.room
  // another user signed in since this session was created: forget it locally (leave_room would hit the new user)
  ctx.room?.drop()
  ctx.room = new RoomSession({
    client: ctx.client,
    emit: ctx.emit,
    userId: session.user.id,
    cache: new NicknameCache(ctx.client),
    fresh: () => ensureFreshSession(ctx.client, ctx.store, ctx.marginS),
  })
  return ctx.room
}

export const routes: Routes = {
  '/ping': async () => ({}),
  '/status': async (ctx) => ({ auth: await authState(ctx.client), room: ctx.room?.current() ?? null }),
  '/login': async (ctx) => ({ url: (await beginLogin(ctx)).url }),
  '/nickname/check': async (ctx, { nick }) => ({
    available: await rpc<boolean>(ctx.client, 'nickname_available', { nick }),
  }),
  '/nickname/claim': async (ctx, { nick }) => {
    const p = await rpc<{ nickname: string; github_created_at: string | null }>(ctx.client, 'claim_nickname', { nick })
    if (!p.github_created_at) await fetchGithubAge(ctx.client)
    await emitAuth(ctx)
    return { nickname: p.nickname }
  },
  '/rules/accept': async (ctx) => {
    await rpc(ctx.client, 'accept_rules')
    await emitAuth(ctx)
    return {}
  },
  '/logout': async (ctx) => {
    await leaveIfJoined(ctx)
    await ctx.client.auth.signOut({ scope: 'local' })
    await ctx.store.clear()
    ctx.signedIn = false
    ctx.emit({ type: 'auth', state: 'signed_out' })
    return {}
  },
  '/delete-account': async (ctx) => {
    await leaveIfJoined(ctx)
    await rpc(ctx.client, 'delete_my_account')
    await ctx.client.auth.signOut({ scope: 'local' }).catch(() => {})
    await ctx.store.clear()
    ctx.signedIn = false
    ctx.emit({ type: 'auth', state: 'signed_out' })
    return {}
  },
  '/join': async (ctx, { room }) => (await roomOf(ctx)).join(room),
  '/leave': async (ctx) => {
    if (ctx.room) await ctx.room.leave()
    else await rpc(ctx.client, 'leave_room').catch(() => {})
    return {}
  },
  '/send': async (ctx, { body }) => (await roomOf(ctx)).send(body),
  '/report': async (ctx, { nickname, message_id, reason }) => (await roomOf(ctx)).report(nickname, message_id, reason),
  '/mod/delete': async (ctx, { message_id, reason }) => {
    await (await roomOf(ctx)).modDelete(message_id, reason)
    return {}
  },
  '/mod/mute': async (ctx, { nickname, minutes, reason }) => {
    await (await roomOf(ctx)).modMute(nickname, minutes, reason)
    return {}
  },
  '/mod/ban': async (ctx, { nickname, reason }) => {
    await (await roomOf(ctx)).modBan(nickname, reason)
    return {}
  },
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

export function createFetchHandler(ctx: Ctx, table: Routes = routes) {
  return async (req: Request): Promise<Response> => {
    ctx.touch()
    const path = new URL(req.url).pathname
    const handler = table[path as ApiPath] as Handler<ApiPath> | undefined
    if (req.method !== 'POST' || !handler) return json({ ok: false, code: 'not_found' }, 404)
    let body: unknown
    try {
      const text = await req.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return json({ ok: false, code: 'bad_request' }, 400)
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ ok: false, code: 'bad_request' }, 400)
    try {
      if (!SIGNED_OUT_OK.has(path)) {
        // supabase-js refreshes on its own if the token expired, outside our lock: refresh under the lock first
        const session = await ensureFreshSession(ctx.client, ctx.store, ctx.marginS)
        if (!session) return json({ ok: false, code: 'not_signed_in' })
      } else if (await peekSession(ctx.client)) {
        // liveness routes must not fail on a transient refresh error; the tick retries
        await ensureFreshSession(ctx.client, ctx.store, ctx.marginS).catch(() => {})
      }
      return json({ ok: true, data: await handler(ctx, body as never) })
    } catch (e) {
      const message = e instanceof Error && !(e instanceof CoffeeError && e.message === e.code) ? e.message : undefined
      return json({ ok: false, code: codeOf(e), ...(message ? { message } : {}) })
    }
  }
}

export function startServer(socketPath: string, ctx: Ctx) {
  return Bun.serve({ unix: socketPath, fetch: createFetchHandler(ctx) })
}
