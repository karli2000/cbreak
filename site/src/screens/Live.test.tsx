import { describe, expect, jest, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthProvider } from '../auth.tsx'
import type { ChatMessage } from '../api.ts'
import { fakeApi } from './../fake-api.ts'
import { Live } from './Live.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'm1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

const msg = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  user_id: `u${id}`,
  nickname: `nick${id}`,
  body: `body ${id}`,
  created_at: '2026-11-12T10:00:00Z',
  ...over,
})

function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    roomCounts: async () => [
      { room: 'lobby', instance: 1, here: 7 },
      { room: 'lobby', instance: 2, here: 3 },
    ],
    recentMessages: async (room, instance) => (instance === 1 ? [msg(1), msg(2)] : [msg(50)]),
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Live api={api} />
    </AuthProvider>,
  )
  return api
}

const pick = async (name: string) => {
  const b = await screen.findByRole('button', { name })
  await act(async () => {
    fireEvent.click(b)
  })
}

describe('Live', () => {
  test('lists instances', async () => {
    setup()
    expect(await screen.findByRole('button', { name: 'lobby · 1 — 7 here' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'lobby · 2 — 3 here' })).toBeTruthy()
    expect(screen.getByText("You are watching silently; people in the room don't see you.")).toBeTruthy()
  })

  test('shows backlog then live messages', async () => {
    const api = setup()
    await pick('lobby · 1 — 7 here')
    expect(await screen.findByText('body 1')).toBeTruthy()
    expect(screen.getByText('body 2')).toBeTruthy()
    expect(api.live.subscriptions).toEqual([{ room: 'lobby', instance: 1 }])
    act(() => api.live.emitStatus('live'))
    expect(screen.getByText('live')).toBeTruthy()
    act(() => api.live.emitMessage(msg(3)))
    expect(screen.getByText('body 3')).toBeTruthy()
  })

  test('deleted removes the line', async () => {
    const api = setup()
    await pick('lobby · 1 — 7 here')
    await screen.findByText('body 2')
    act(() => api.live.emitDeleted(2))
    expect(screen.queryByText('body 2')).toBeNull()
    expect(screen.getByText('body 1')).toBeTruthy()
  })

  test('switching instance unsubscribes the old one and ignores its late events', async () => {
    const api = setup()
    await pick('lobby · 1 — 7 here')
    await screen.findByText('body 1')
    await pick('lobby · 2 — 3 here')
    await screen.findByText('body 50')
    expect(api.live.unsubscribes).toBe(1)
    expect(api.live.subscriptions).toHaveLength(2)
    act(() => api.live.emitMessage(msg(9), 0))
    expect(screen.queryByText('body 9')).toBeNull()
    expect(screen.queryByText('body 1')).toBeNull()
  })

  test('a stale backlog result is ignored', async () => {
    let release: (m: ChatMessage[]) => void = () => {}
    const api = setup({
      recentMessages: (room, instance) =>
        instance === 1 ? new Promise<ChatMessage[]>((r) => (release = r)) : Promise.resolve([msg(50)]),
    })
    await pick('lobby · 1 — 7 here')
    await pick('lobby · 2 — 3 here')
    await screen.findByText('body 50')
    await act(async () => release([msg(1)]))
    expect(screen.queryByText('body 1')).toBeNull()
    expect(api.live.subscriptions).toEqual([{ room: 'lobby', instance: 2 }])
  })

  test('leaving the tab unsubscribes', async () => {
    const api = setup()
    await pick('lobby · 1 — 7 here')
    await screen.findByText('body 1')
    cleanup()
    expect(api.live.unsubscribes).toBe(1)
  })

  test('status error shows connection problem', async () => {
    const api = setup()
    await pick('lobby · 1 — 7 here')
    await screen.findByText('body 1')
    act(() => api.live.emitStatus('error'))
    expect(screen.getByText('connection problem')).toBeTruthy()
  })

  test('keeps 300 lines', async () => {
    const api = setup({ recentMessages: async () => Array.from({ length: 100 }, (_, i) => msg(i + 1)) })
    await pick('lobby · 1 — 7 here')
    await screen.findByText('body 1')
    act(() => {
      for (let i = 101; i <= 350; i++) api.live.emitMessage(msg(i))
    })
    expect(screen.queryByText('body 50')).toBeNull()
    expect(screen.getByText('body 51')).toBeTruthy()
    expect(screen.getByText('body 350')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(300)
  })

  test('delete from a line calls deleteMessage with that id', async () => {
    const api = setup({ deleteMessage: async () => {} })
    await pick('lobby · 1 — 7 here')
    const line = (await screen.findByText('body 2')).closest('li') as HTMLElement
    fireEvent.click(within(line).getByRole('button', { name: '⋯' }))
    expect(within(line).queryByRole('button', { name: 'Mute 10m' })).toBeTruthy()
    fireEvent.click(within(line).getByRole('button', { name: 'Delete message' }))
    await waitFor(() => expect(api.calls.some((c) => c.name === 'deleteMessage')).toBe(true))
    expect(api.calls.find((c) => c.name === 'deleteMessage')?.args).toEqual([2, ''])
  })

  test('a line without user_id only offers delete', async () => {
    setup({ recentMessages: async () => [msg(1, { user_id: null })] })
    await pick('lobby · 1 — 7 here')
    const line = (await screen.findByText('body 1')).closest('li') as HTMLElement
    fireEvent.click(within(line).getByRole('button', { name: '⋯' }))
    expect(within(line).getByRole('button', { name: 'Delete message' })).toBeTruthy()
    expect(within(line).queryByRole('button', { name: 'Ban' })).toBeNull()
    expect(within(line).queryByRole('button', { name: 'Mute 10m' })).toBeNull()
  })

  test('refreshes counts every 30 s and on Refresh, and clears the timer on unmount', async () => {
    jest.useFakeTimers()
    try {
      let here = 7
      const api = setup({ roomCounts: async () => [{ room: 'lobby', instance: 1, here }] })
      await screen.findByRole('button', { name: 'lobby · 1 — 7 here' })
      here = 9
      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      await screen.findByRole('button', { name: 'lobby · 1 — 9 here' })
      here = 11
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      await screen.findByRole('button', { name: 'lobby · 1 — 11 here' })
      const before = api.calls.filter((c) => c.name === 'roomCounts').length
      cleanup()
      jest.advanceTimersByTime(60_000)
      expect(api.calls.filter((c) => c.name === 'roomCounts').length).toBe(before)
    } finally {
      jest.useRealTimers()
    }
  })
})
