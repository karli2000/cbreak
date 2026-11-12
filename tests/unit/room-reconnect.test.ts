// RoomSession reconnect loop and leave() against a fake client (no stack needed).
import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HelperEvent } from '../../plugin/shared/protocol'
import { NicknameCache, RoomSession } from '../../plugin/helper/room'

const info = { room: 'r', instance: 1, topic: 'room:r:1', here: 1 }

/** Fake client: every subscribe answers with the next status from `statuses` (then SUBSCRIBED). */
function fakeClient(statuses: string[], rpcs: Record<string, () => { data?: unknown; error?: { message: string } }> = {}) {
  const calls: string[] = []
  const query: any = new Proxy({}, {
    get: (_t, k) => (k === 'then' ? (r: (v: unknown) => void) => r({ data: [], error: null }) : () => query),
  })
  const client = {
    rpc: async (fn: string) => {
      calls.push(fn)
      const f = rpcs[fn]
      if (f) {
        const r = f()
        return { data: r.data ?? null, error: r.error ?? null }
      }
      return { data: fn === 'join_room' || fn === 'heartbeat' ? info : null, error: null }
    },
    channel: () => {
      const ch: any = {
        on: () => ch,
        subscribe: (cb: (s: string) => void) => {
          calls.push('subscribe')
          queueMicrotask(() => cb(statuses.shift() ?? 'SUBSCRIBED'))
          return ch
        },
        track: async () => 'ok',
        presenceState: () => ({}),
      }
      return ch
    },
    removeChannel: async () => {
      calls.push('removeChannel')
      return 'ok'
    },
    from: () => query,
  } as unknown as SupabaseClient
  return { client, calls }
}

function session(client: SupabaseClient) {
  const events: HelperEvent[] = []
  const room = new RoomSession({ client, emit: (e) => events.push(e), userId: 'me', cache: new NicknameCache(client) })
  return { room, events }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test('failed subscribes back off 1, 2, 4 s with a heartbeat each, report unavailable after the 3rd, then go online', async () => {
  const { client, calls } = fakeClient(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])
  const { room, events } = session(client)

  expect(await room.join('r')).toEqual(info)
  expect(events.map((e) => e.type)).toEqual(['connection', 'joined', 'backlog'])
  expect(events[0]).toEqual({ type: 'connection', state: 'reconnecting' })
  const subs = () => calls.filter((c) => c === 'subscribe').length
  expect(subs()).toBe(1)

  jest.advanceTimersByTime(999)
  await flush()
  expect(subs()).toBe(1)
  jest.advanceTimersByTime(1)
  await flush()
  expect(subs()).toBe(2) // after 1 s
  // every re-subscribe is preceded by a heartbeat
  const beats = calls.filter((c) => c === 'heartbeat' || c === 'subscribe').join(',')
  expect(beats).toBe('subscribe,heartbeat,subscribe')

  jest.advanceTimersByTime(2000)
  await flush()
  expect(subs()).toBe(3) // after 2 s more
  expect(events.at(-1)).toEqual({ type: 'error', code: 'realtime_unavailable' })

  jest.advanceTimersByTime(3999)
  await flush()
  expect(subs()).toBe(3)
  jest.advanceTimersByTime(1)
  await flush()
  expect(subs()).toBe(4) // after 4 s more
  expect(events.at(-1)).toEqual({ type: 'connection', state: 'online' })
  expect(calls.filter((c) => c === 'heartbeat')).toHaveLength(3)
  expect(events.filter((e) => e.type === 'connection' && e.state === 'reconnecting')).toHaveLength(1)
  expect(room.current()).toEqual(info)
})

test('leave stops the retry loop and never throws', async () => {
  const { client, calls } = fakeClient(['CHANNEL_ERROR'], { leave_room: () => ({ error: { message: 'network' } }) })
  const { room } = session(client)
  await room.join('r')
  await room.leave()
  expect(room.current()).toBeNull()
  expect(calls).toContain('leave_room')
  const before = calls.length
  jest.advanceTimersByTime(60_000)
  await flush()
  expect(calls.length).toBe(before)
})

test('room_closed from the heartbeat emits room_closed and leaves', async () => {
  const { client, calls } = fakeClient([], { heartbeat: () => ({ error: { message: 'room_closed' } }) })
  const { room, events } = session(client)
  await room.join('r')
  await room.heartbeat()
  expect(events.at(-1)).toEqual({ type: 'room_closed' })
  expect(calls).toContain('leave_room')
  expect(room.current()).toBeNull()
})
