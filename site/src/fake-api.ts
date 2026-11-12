// Test helper: a Bound api that records calls; anything not overridden rejects with not_found.
import { ApiError, type Bound, type ChatMessage } from './api.ts'

export type Call = { name: string; args: unknown[] }
type Handlers = { message(m: ChatMessage): void; deleted(id: number): void; status(s: 'live' | 'error'): void }
/** Controls the default watchRoom. emit* go to the newest subscription, or to `which` (index into subscriptions). */
export type Live = {
  subscriptions: { room: string; instance: number }[]
  unsubscribes: number
  emitMessage(m: ChatMessage, which?: number): void
  emitDeleted(id: number, which?: number): void
  emitStatus(s: 'live' | 'error', which?: number): void
}
export type FakeApi = Bound & { calls: Call[]; live: Live }

export function fakeApi(overrides: Partial<Bound> = {}): FakeApi {
  const calls: Call[] = []
  const handlers: Handlers[] = []
  const pick = (which?: number) => handlers[which ?? handlers.length - 1]
  const live: Live = {
    subscriptions: [],
    unsubscribes: 0,
    emitMessage: (m, w) => pick(w)?.message(m),
    emitDeleted: (id, w) => pick(w)?.deleted(id),
    emitStatus: (s, w) => pick(w)?.status(s),
  }
  const target: Record<string, unknown> = { calls, live }
  return new Proxy(target, {
    get(t, name) {
      if (typeof name !== 'string' || name === 'calls' || name === 'live') return t[name as string]
      return (...args: unknown[]) => {
        calls.push({ name, args })
        const f = (overrides as Record<string, ((...a: unknown[]) => unknown) | undefined>)[name]
        if (f) return f(...args)
        if (name === 'watchRoom') {
          const [room, instance, on] = args as [string, number, Handlers]
          live.subscriptions.push({ room, instance })
          handlers.push(on)
          return () => {
            live.unsubscribes++
          }
        }
        return Promise.reject(new ApiError('not_found'))
      }
    },
  }) as FakeApi
}
