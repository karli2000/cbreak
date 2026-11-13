// Every join_room, heartbeat and leave_room call carries the helper's session id (fake client, no stack).
import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NicknameCache, RoomSession } from '../../plugin/helper/room'

const info = { room: 'r', instance: 1, topic: 'room:r:1', here: 1 }
const SID = '11111111-2222-4333-8444-555555555555'

test('join, heartbeat and leave send the session id, also on the re-join after not_in_room', async () => {
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

  await room.join('r')
  await room.heartbeat() // not_in_room -> re-join
  await room.heartbeat()
  await room.leave()

  const seq = calls.map((c) => c.fn)
  expect(seq).toEqual(['join_room', 'heartbeat', 'join_room', 'heartbeat', 'leave_room'])
  for (const c of calls) expect(c.args).toMatchObject({ session_id: SID })
  expect(calls[0]!.args).toEqual({ room_slug: 'r', session_id: SID })
  expect(calls[2]!.args).toEqual({ room_slug: 'r', session_id: SID })
})
