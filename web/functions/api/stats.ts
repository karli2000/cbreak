// GET /api/stats on cbreak.dev (a Cloudflare Pages Function): the homepage numbers from the
// public_stats() RPC (migration 20261116000100), cached for 60 s per Cloudflare location, so the
// database sees at most one call a minute per location however many people open the page.
// Visitors' browsers only ever talk to cbreak.dev. Only the known fields are passed on.
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../../plugin/shared/backend.ts'

export const MAX_AGE_S = 60

type CacheLike = {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: unknown): Promise<unknown>
}
/** Pages env vars; set only for a local run (`wrangler pages dev --binding …`). */
type Env = { SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string }
type Ctx = { request: Request; env: Env; waitUntil(promise: Promise<unknown>): void }

const COUNTS = ['chatting', 'users_total', 'users_today', 'messages_total', 'messages_today'] as const
const TEXTS = ['day', 'as_of'] as const

/** The fields the page uses, or null when the answer is not what public_stats() returns. */
function pick(raw: unknown): Record<string, number | string> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const out: Record<string, number | string> = {}
  for (const k of COUNTS) {
    const v = r[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
    out[k] = v
  }
  for (const k of TEXTS) {
    const v = r[k]
    if (typeof v !== 'string') return null
    out[k] = v
  }
  return out
}

const unavailable = () =>
  Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })

export async function stats(ctx: Ctx, cache: CacheLike | undefined, doFetch: typeof fetch = fetch): Promise<Response> {
  // One cache entry, whatever query string a visitor adds.
  const key = new Request(new URL('/api/stats', ctx.request.url).toString())
  const hit = await cache?.match(key)
  if (hit) return hit

  const url = ctx.env.SUPABASE_URL ?? SUPABASE_URL
  const anon = ctx.env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY
  let body: Record<string, number | string> | null
  try {
    const r = await doFetch(`${url}/rest/v1/rpc/public_stats`, {
      method: 'POST',
      headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
      body: '{}',
    })
    body = r.ok ? pick(await r.json()) : null
  } catch {
    body = null
  }
  if (!body) return unavailable()

  const res = Response.json(body, {
    headers: { 'cache-control': `public, max-age=${MAX_AGE_S}`, 'x-content-type-options': 'nosniff' },
  })
  // cache.put honours the max-age above; the visitor gets the answer without waiting for it.
  if (cache) ctx.waitUntil(cache.put(key, res.clone()))
  return res
}

/** The Pages entry point. `caches.default` exists on custom domains; on *.pages.dev it is a no-op. */
export const onRequestGet = (ctx: Ctx): Promise<Response> =>
  stats(ctx, (globalThis as { caches?: { default?: CacheLike } }).caches?.default)
