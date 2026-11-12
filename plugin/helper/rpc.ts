import type { SupabaseClient } from '@supabase/supabase-js'

export class CoffeeError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code)
    this.name = 'CoffeeError'
  }
}

/** Transport failures: fetch rejections and the socket errno names behind them. */
const TRANSPORT =
  /^(TypeError|FetchError|AbortError|TimeoutError):|fetch failed|Unable to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ECONNRESET|EHOSTUNREACH|ECONNABORTED|EPIPE/i

/**
 * Maps any thrown/returned error to a short machine code. postgrest-js does not throw on a failed
 * fetch: it returns `{message: '<Name>: <msg>', code: ''}`, so a transport-shaped message without a
 * SQLSTATE counts as `network` too.
 */
export function codeOf(err: unknown): string {
  if (err instanceof CoffeeError) return err.code
  const obj = typeof err === 'object' && err !== null ? (err as { message?: unknown; code?: unknown }) : null
  const msg = obj && 'message' in obj ? String(obj.message) : ''
  if (/^[a-z_]+$/.test(msg)) return msg
  if (err instanceof TypeError) return 'network'
  // a SQLSTATE (5 chars with a digit, e.g. P0001, 42883) or a PostgREST code; errno codes (ECONNRESET) do not count
  const code = typeof obj?.code === 'string' ? obj.code : ''
  const sqlState = (/^[0-9A-Z]{5}$/.test(code) && /\d/.test(code)) || code.startsWith('PGRST')
  if (!sqlState && TRANSPORT.test(msg)) return 'network'
  return 'unknown'
}

/** Calls a Postgres RPC; throws CoffeeError with the backend error code. */
export async function rpc<T>(client: SupabaseClient, fn: string, args?: object): Promise<T> {
  let res
  try {
    res = await client.rpc(fn, args as Record<string, unknown> | undefined)
  } catch (e) {
    throw new CoffeeError(codeOf(e), e instanceof Error ? e.message : undefined)
  }
  if (res.error) throw new CoffeeError(codeOf(res.error), res.error.message)
  return res.data as T
}
