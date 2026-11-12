// RoomSession presence against a fake channel: the initial state is not announced, joins/leaves are
// batched per sync with one nickname query, and events keep their order.
import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HelperEvent } from '../../plugin/shared/protocol'
import { NicknameCache, RoomSession } from '../../plugin/helper/room'

const info = { room: 'r', instance: 1, topic: 'room:r:1', here: 1 }
type Handler = (p: any) => void

function fakeClient() {
  const queries: string[][] = []
  const handlers: Record<string, Handler[]> = {}
  let state: Record<string, unknown[]> = {}
  let release: (() => void) | null = null
  const nick = (id: string) => ({ id, nickname: `n-${id}`, role: 'user' })
  const from = () => {
    let ids: string[] = []
    const q: any = {
      select: () => q,
      eq: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      in: (_c: string, v: string[]) => ((ids = v), queries.push(v), q),
      then: (r: (v: unknown) => void) => {
        const answer = () => r({ data: ids.map(nick), error: null })
        if (ids.includes('slow')) release = answer
        else answer()
      },
    }
    return q
  }
  const client = {
    rpc: async (fn: string) => ({ data: fn === 'join_room' || fn === 'heartbeat' ? info : null, error: null }),
    channel: () => {
      const ch: any = {
        on: (type: string, filter: { event: string }, h: Handler) => {
          ;(handlers[`${type}:${filter.event}`] ??= []).push(h)
          return ch
        },
        subscribe: (cb: (s: string) => void) => {
          queueMicrotask(() => cb('SUBSCRIBED'))
          return ch
        },
        track: async () => 'ok',
        presenceState: () => state,
      }
      return ch
    },
    removeChannel: async () => 'ok',
    from,
  } as unknown as SupabaseClient
  const fire = (event: string, p: any = {}) => (handlers[`presence:${event}`] ?? []).forEach((h) => h({ event, ...p }))
  return {
    client,
    queries,
    setState: (keys: string[]) => (state = Object.fromEntries(keys.map((k) => [k, [{}]]))),
    join: (key: string, current: unknown[] = []) => fire('join', { key, currentPresences: current, newPresences: [{}] }),
    leave: (key: string, current: unknown[] = []) => fire('leave', { key, currentPresences: current, leftPresences: [{}] }),
    sync: () => fire('sync'),
    releaseSlow: () => release?.(),
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function joined() {
  const f = fakeClient()
  const events: HelperEvent[] = []
  const room = new RoomSession({ client: f.client, emit: (e) => events.push(e), userId: 'me', cache: new NicknameCache(f.client) })
  await room.join('r')
  f.queries.length = 0 // backlog lookups
  const presence = () => events.filter((e) => e.type === 'presence')
  return { f, room, events, presence }
}

test('the initial presence state is one event with the count and no names, and no lookups', async () => {
  const { f, presence } = await joined()
  f.setState(['b', 'c', 'me'])
  f.join('b')
  f.join('c')
  f.join('me')
  f.sync()
  await flush()
  expect(presence()).toEqual([{ type: 'presence', here: 3, joined: [], left: [] }])
  expect(f.queries).toEqual([])
})

test('later joins and leaves of one sync are one event with one nickname query', async () => {
  const { f, presence } = await joined()
  f.setState(['b', 'me'])
  f.join('b')
  f.sync()
  await flush()
  f.setState(['me', 'd', 'e'])
  f.join('d')
  f.join('e')
  f.leave('b')
  f.join('me', [{}]) // own re-track: not new, and never announced
  f.sync()
  await flush()
  expect(presence().at(-1)).toEqual({ type: 'presence', here: 3, joined: ['n-d', 'n-e'], left: ['n-b'] })
  expect(f.queries).toEqual([['d', 'e', 'b']])
})

test('a second presence of a key already there is neither a join nor a leave', async () => {
  const { f, presence } = await joined()
  f.setState(['b', 'me'])
  f.join('b')
  f.sync()
  await flush()
  f.join('b', [{}]) // b opened a second tab
  f.leave('b', [{}]) // and closed one: b is still here
  f.sync()
  await flush()
  expect(presence().slice(1)).toEqual([])
})

test('presence events keep their order when a lookup is slow', async () => {
  const { f, presence } = await joined()
  f.setState(['me'])
  f.sync()
  await flush()
  f.setState(['me', 'slow'])
  f.join('slow')
  f.sync()
  f.setState(['me', 'slow', 'x'])
  f.join('x')
  f.sync()
  await flush()
  expect(presence()).toHaveLength(1)
  f.releaseSlow()
  await flush()
  expect(presence().slice(1).map((e) => (e as { joined: string[] }).joined)).toEqual([['n-slow'], ['n-x']])
})
