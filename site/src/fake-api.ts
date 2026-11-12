// Test helper: a Bound api that records calls; anything not overridden rejects with not_found.
import { ApiError, type Bound } from './api.ts'

export type Call = { name: string; args: unknown[] }
export type FakeApi = Bound & { calls: Call[] }

export function fakeApi(overrides: Partial<Bound> = {}): FakeApi {
  const calls: Call[] = []
  const target: Record<string, unknown> = { calls }
  return new Proxy(target, {
    get(t, name) {
      if (typeof name !== 'string' || name === 'calls') return t[name as string]
      return (...args: unknown[]) => {
        calls.push({ name, args })
        const f = (overrides as Record<string, ((...a: unknown[]) => unknown) | undefined>)[name]
        if (f) return f(...args)
        if (name === 'watchRoom') return () => {}
        return Promise.reject(new ApiError('not_found'))
      }
    },
  }) as FakeApi
}
