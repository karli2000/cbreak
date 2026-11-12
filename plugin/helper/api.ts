import type { SupabaseClient } from '@supabase/supabase-js'
import type { Api, ApiPath, HelperEvent } from '../shared/protocol'
import { AuthStore, authState, ensureFreshSession, peekSession } from './auth'
import { CoffeeError, codeOf, rpc } from './rpc'

export type Emit = (e: HelperEvent) => void

export type Ctx = {
  client: SupabaseClient
  store: AuthStore
  emit: Emit
  room: { leave(): Promise<void> } | null
  touch(): void
  /** Refresh margin in seconds for ensureFreshSession. */
  marginS: number
  /** Whether a session was present at the last check; route handlers that sign out reset it. */
  signedIn: boolean
}

type Handler<P extends ApiPath> = (ctx: Ctx, req: Api[P]['req']) => Promise<Api[P]['res']>
export type Routes = { [P in ApiPath]?: Handler<P> }

/** Routes that work without a session. Task 4 adds '/login'. */
export const SIGNED_OUT_OK: ReadonlySet<string> = new Set(['/ping', '/status', '/login'])

/** Calls the github-age Edge Function once; failures are ignored (email test users get 400). */
export async function fetchGithubAge(client: SupabaseClient): Promise<void> {
  try {
    await client.functions.invoke('github-age')
  } catch {}
}

/** Emits the current auth state; a transient failure is reported as an error event instead. */
export async function emitAuth(ctx: Pick<Ctx, 'client' | 'emit'>): Promise<void> {
  try {
    ctx.emit({ type: 'auth', ...(await authState(ctx.client)) })
  } catch (e) {
    ctx.emit({ type: 'error', code: codeOf(e) })
  }
}

async function leaveIfJoined(ctx: Ctx): Promise<void> {
  if (ctx.room) await ctx.room.leave()
}

export const routes: Routes = {
  '/ping': async () => ({}),
  '/status': async (ctx) => ({ auth: await authState(ctx.client), room: null }),
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
