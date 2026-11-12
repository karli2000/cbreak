import type { SupabaseClient } from '@supabase/supabase-js'

export class CoffeeError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code)
    this.name = 'CoffeeError'
  }
}

/** Maps any thrown/returned error to a short machine code. */
export function codeOf(err: unknown): string {
  if (err instanceof CoffeeError) return err.code
  const msg = typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : ''
  if (/^[a-z_]+$/.test(msg)) return msg
  if (err instanceof TypeError || /fetch failed|ECONNREFUSED/i.test(msg)) return 'network'
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
