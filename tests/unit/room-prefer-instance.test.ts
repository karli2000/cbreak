// join_room carries the instance the client asks to go back to (prefer_instance), and a re-join
// after not_in_room asks for the instance the helper is in (fake client, no stack).
import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NicknameCache, RoomSession } from '../../plugin/helper/room'

const SID = '11111111-2222-4333-8444-555555555555'

function fake(instance: number) {
  const info = { room: 'r', instance, topic: `room:r:${instance}`, here: 2 }
  const calls: { fn: string; args: Record<string, unknown> | undefined }[] = []
  let beats = 0
  const query: any = new Proxy({}, {
    get: (_t, k) => (k === 'then' ? (r: (v: unknown) => void) => r({ data: [], error: null }) : () => query),
  })
  const client = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (fn === 'heartbeat' && beats++ === 0) return { data: null, error: { message: 'not_in_room', code: 'P0001' } }
      return { data: fn === 'join_room' || fn === 'heartbeat' ? info : null, error: null }
    },
    channel: () => {
      const ch: any = {
        on: () => ch,
        subscribe: (cb: (s: string) => void) => (queueMicrotask(() => cb('SUBSCRIBED')), ch),
        track: async () => 'ok',
        presenceState: () => ({}),
      }
      return ch
    },
    removeChannel: async () => 'ok',
    from: () => query,
  } as unknown as SupabaseClient
  const room = new RoomSession({ client, emit: () => {}, userId: 'me', cache: new NicknameCache(client), sessionId: SID })
  return { room, calls }
}

test('join without a preference sends no prefer_instance', async () => {
  const { room, calls } = fake(1)
  await room.join('r')
  expect(calls[0]).toEqual({ fn: 'join_room', args: { room_slug: 'r', session_id: SID } })
  await room.leave()
})

test('join with a preference sends prefer_instance', async () => {
  const { room, calls } = fake(2)
  await room.join('r', 2)
  expect(calls[0]).toEqual({ fn: 'join_room', args: { room_slug: 'r', session_id: SID, prefer_instance: 2 } })
  await room.leave()
})

test('the re-join after not_in_room asks for the current instance', async () => {
  const { room, calls } = fake(3)
  await room.join('r')
  await room.heartbeat() // not_in_room -> re-join
  expect(calls.map((c) => c.fn)).toEqual(['join_room', 'heartbeat', 'join_room'])
  expect(calls[2]!.args).toEqual({ room_slug: 'r', session_id: SID, prefer_instance: 3 })
  await room.leave()
})
