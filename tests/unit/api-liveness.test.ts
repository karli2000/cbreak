import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFetchHandler, routes, type Ctx } from '../../plugin/helper/api'
import type { AuthStore } from '../../plugin/helper/auth'
import { CoffeeError } from '../../plugin/helper/rpc'

// a session that is expired, so ensureFreshSession must go to the store lock, which fails with 'network'
const expired = { access_token: 'a', refresh_token: 'r', expires_at: 1 }
const client = {
  auth: { getSession: async () => ({ data: { session: expired } }) },
  rpc: async () => ({ data: null, error: null }),
} as unknown as SupabaseClient
const store = {
  withLock: async () => {
    throw new CoffeeError('network')
  },
} as unknown as AuthStore
const ctx: Ctx = { client, store, emit: () => {}, room: null, touch: () => {}, marginS: 120, signedIn: true }
const post = (path: string) => createFetchHandler(ctx, routes)(new Request('http://x' + path, { method: 'POST', body: '{}' }))

test('/ping returns {} even when the session refresh fails with network', async () => {
  const res = await post('/ping')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, data: {} })
})

test('a protected route reports network when the refresh fails', async () => {
  expect(await (await post('/nickname/check')).json()).toMatchObject({ ok: false, code: 'network' })
})
