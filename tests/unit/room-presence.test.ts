// RoomSession presence comes from the server's `presence` broadcasts (join_room, leave_room, mod_ban,
// purge): nickname and count from the payload, never from client presence keys. Own events are not
// lines, malformed payloads are dropped, and the count reaches `current()`.
import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HelperEvent } from '../../plugin/shared/protocol'
import { NicknameCache, RoomSession } from '../../plugin/helper/room'

const info = { room: 'r', instance: 1, topic: 'room:r:1', here: 1 }
type Handler = (p: any) => void

function fakeClient() {
  const handlers: Record<string, Handler[]> = {}
  const configs: unknown[] = []
  const tracked: unknown[] = []
  const query: any = new Proxy({}, {
    get: (_t, k) => (k === 'then' ? (r: (v: unknown) => void) => r({ data: [], error: null }) : () => query),
  })
  const client = {
    rpc: async (fn: string) => ({ data: fn === 'join_room' || fn === 'heartbeat' ? info : null, error: null }),
    channel: (_topic: string, config: unknown) => {
      configs.push(config)
      const ch: any = {
        on: (type: string, filter: { event: string }, h: Handler) => {
          ;(handlers[`${type}:${filter.event}`] ??= []).push(h)
          return ch
        },
        subscribe: (cb: (s: string) => void) => {
          queueMicrotask(() => cb('SUBSCRIBED'))
          return ch
        },
        track: async (p: unknown) => (tracked.push(p), 'ok'),
        presenceState: () => ({}),
      }
      return ch
    },
    removeChannel: async () => 'ok',
    from: () => query,
  } as unknown as SupabaseClient
  const broadcast = (payload: unknown) => (handlers['broadcast:presence'] ?? []).forEach((h) => h({ event: 'presence', payload }))
  const presenceHandlers = () => Object.keys(handlers).filter((k) => k.startsWith('presence:'))
  return { client, broadcast, configs, tracked, presenceHandlers }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function joined() {
  const f = fakeClient()
  const events: HelperEvent[] = []
  const room = new RoomSession({ client: f.client, emit: (e) => events.push(e), userId: 'me', cache: new NicknameCache(f.client), sessionId: 's' })
  await room.join('r')
  const presence = () => events.filter((e) => e.type === 'presence')
  return { f, room, events, presence }
}

test('the channel uses no client presence: no key, no track, no presence handlers', async () => {
  const { f } = await joined()
  expect(f.configs).toEqual([{ config: { private: true } }])
  expect(f.tracked).toEqual([])
  expect(f.presenceHandlers()).toEqual([])
})

test('a server join or leave broadcast becomes one presence event with the nickname and the count', async () => {
  const { f, room, presence } = await joined()
  f.broadcast({ event: 'join', user_id: 'u-lena', nickname: 'lena', here: 4 })
  f.broadcast({ event: 'leave', user_id: 'u-ravi', nickname: 'ravi', here: 3 })
  await flush()
  expect(presence()).toEqual([
    { type: 'presence', here: 4, joined: ['lena'], left: [] },
    { type: 'presence', here: 3, joined: [], left: ['ravi'] },
  ])
  expect(room.current()).toEqual({ ...info, here: 3 })
})

test('own join and leave are not announced', async () => {
  const { f, presence } = await joined()
  f.broadcast({ event: 'join', user_id: 'me', nickname: 'me_nick', here: 2 })
  f.broadcast({ event: 'leave', user_id: 'me', nickname: 'me_nick', here: 1 })
  await flush()
  expect(presence()).toEqual([])
})

test('malformed payloads are dropped', async () => {
  const { f, presence } = await joined()
  f.broadcast({ event: 'join', user_id: 'x', nickname: 42, here: 2 })
  f.broadcast({ event: 'join', user_id: 'x', nickname: 'x', here: 'two' })
  f.broadcast({ event: 'poke', user_id: 'x', nickname: 'x', here: 2 })
  f.broadcast(null)
  f.broadcast('join')
  await flush()
  expect(presence()).toEqual([])
})
