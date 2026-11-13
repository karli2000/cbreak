// GET /api/stats on cbreak.dev (web/functions/api/stats.ts): the homepage numbers from the
// public_stats() RPC, cached for 60 s per Cloudflare location, with nothing else passed on.
import { describe, expect, test } from 'bun:test'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../plugin/shared/backend.ts'
import { MAX_AGE_S, stats } from '../../web/functions/api/stats.ts'

const NUMBERS = {
  chatting: 3,
  users_total: 128,
  users_today: 4,
  messages_total: 5321,
  messages_today: 210,
  day: '2026-11-13',
  as_of: '2026-11-13T12:00:00.123+00:00',
}

/** A Cache API stand-in keyed by URL, plus the waitUntil promises. */
function world(answer: () => Response | Promise<Response>) {
  const store = new Map<string, unknown>()
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const pending: Promise<unknown>[] = []
  const cache = {
    match: async (r: Request) => (store.get(r.url) as Response | undefined)?.clone() as Response | undefined,
    put: async (r: Request, res: unknown) => void store.set(r.url, res),
  }
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return answer()
  }) as unknown as typeof fetch
  const ctx = (env: Record<string, string> = {}) => ({
    request: new Request('https://cbreak.dev/api/stats?x=1'),
    env,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
  })
  return { store, calls, pending, cache, doFetch, ctx }
}

describe('/api/stats', () => {
  test('asks public_stats() with the public anon key and answers its numbers, cacheable for 60 s', async () => {
    const w = world(() => Response.json(NUMBERS))
    const res = await stats(w.ctx(), w.cache, w.doFetch)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(NUMBERS)
    expect(MAX_AGE_S).toBe(60)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]!.url).toBe(`${SUPABASE_URL}/rest/v1/rpc/public_stats`)
    expect(w.calls[0]!.init?.method).toBe('POST')
    const h = new Headers(w.calls[0]!.init?.headers)
    expect(h.get('apikey')).toBe(SUPABASE_ANON_KEY)
    expect(h.get('authorization')).toBe(`Bearer ${SUPABASE_ANON_KEY}`)
  })

  test('a second request within the minute is answered from the cache, whatever its query string', async () => {
    const w = world(() => Response.json(NUMBERS))
    await stats(w.ctx(), w.cache, w.doFetch)
    await Promise.all(w.pending)
    expect([...w.store.keys()]).toEqual(['https://cbreak.dev/api/stats'])
    const again = await stats(w.ctx(), w.cache, w.doFetch)
    expect(await again.json()).toEqual(NUMBERS)
    expect(w.calls).toHaveLength(1)
  })

  test('passes on only the known fields, and only numbers as numbers', async () => {
    const w = world(() => Response.json({ ...NUMBERS, secret: 'x' }))
    expect(await (await stats(w.ctx(), w.cache, w.doFetch)).json()).toEqual(NUMBERS)
    const bad = world(() => Response.json({ ...NUMBERS, chatting: '3' }))
    expect((await stats(bad.ctx(), bad.cache, bad.doFetch)).status).toBe(503)
  })

  test('a failing backend answers 503, never cached', async () => {
    for (const answer of [() => new Response('nope', { status: 500 }), () => Promise.reject(new TypeError('fetch failed'))]) {
      const w = world(answer)
      const res = await stats(w.ctx(), w.cache, w.doFetch)
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ error: 'unavailable' })
      await Promise.all(w.pending)
      expect(w.store.size).toBe(0)
    }
  })

  test('works without a cache (pages.dev previews have none)', async () => {
    const w = world(() => Response.json(NUMBERS))
    expect(await (await stats(w.ctx(), undefined, w.doFetch)).json()).toEqual(NUMBERS)
  })

  test('the backend can be pointed elsewhere for local runs (Pages env vars)', async () => {
    const w = world(() => Response.json(NUMBERS))
    await stats(w.ctx({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_ANON_KEY: 'local-anon' }), w.cache, w.doFetch)
    expect(w.calls[0]!.url).toBe('http://127.0.0.1:54321/rest/v1/rpc/public_stats')
    expect(new Headers(w.calls[0]!.init?.headers).get('apikey')).toBe('local-anon')
  })
})
