import { describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ApiError, me, resolveReport } from './api.ts'

/** A client whose rpc() resolves to `result`, or rejects with `thrown`. */
function client(result: unknown, thrown?: unknown): SupabaseClient {
  return { rpc: () => (thrown !== undefined ? Promise.reject(thrown) : Promise.resolve(result)) } as unknown as SupabaseClient
}

async function codeOf(c: SupabaseClient): Promise<string> {
  try {
    await resolveReport(c, 1, 'dismissed')
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return (e as ApiError).code
  }
  throw new Error('expected a rejection')
}

describe('api error mapping', () => {
  test('a PostgREST code message is the code', async () => {
    expect(await codeOf(client({ data: null, error: { message: 'forbidden' }, status: 400 }))).toBe('forbidden')
  })

  test('HTTP 401 is not_authenticated', async () => {
    expect(await codeOf(client({ data: null, error: { message: 'Unauthorized' }, status: 401 }))).toBe('not_authenticated')
    expect(await codeOf(client({ data: null, error: { message: 'Invalid token', status: 401 } }))).toBe('not_authenticated')
  })

  test('"JWT expired" is not_authenticated whatever the status', async () => {
    expect(await codeOf(client({ data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 400 }))).toBe(
      'not_authenticated',
    )
  })

  test('status 0 (fetch failed inside supabase-js) is network', async () => {
    expect(await codeOf(client({ data: null, error: { message: 'TypeError: something broke' }, status: 0 }))).toBe('network')
  })

  test('a thrown fetch TypeError is network', async () => {
    expect(await codeOf(client(null, new TypeError('Failed to fetch')))).toBe('network')
    expect(await codeOf(client(null, new TypeError('fetch failed')))).toBe('network')
  })

  test('anything else is unknown', async () => {
    expect(await codeOf(client({ data: null, error: { message: 'Internal Server Error' }, status: 500 }))).toBe('unknown')
    expect(await codeOf(client(null, new Error('Boom')))).toBe('unknown')
  })

  test('me() maps no_profile to null and passes other codes on', async () => {
    expect(await me(client({ data: null, error: { message: 'no_profile' }, status: 400 }))).toBeNull()
    await expect(me(client({ data: null, error: { message: 'banned' }, status: 400 }))).rejects.toMatchObject({ code: 'banned' })
  })
})
