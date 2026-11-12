import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthProvider } from '../auth.tsx'
import { ApiError, type Role } from '../api.ts'
import { fakeApi } from '../fake-api.ts'
import { Bans } from './Bans.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'm1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

function setup(role: Role, over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    listBanned: async () => [{ id: 't1', nickname: 'troll', banned_at: '2026-11-12T09:00:00Z', ban_reason: 'harassment' }],
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Bans api={api} role={role} />
    </AuthProvider>,
  )
  return api
}

describe('bans', () => {
  test('moderators see bans without unban buttons; admins can unban with a reason', async () => {
    setup('moderator')
    expect(await screen.findByText('troll')).toBeTruthy()
    expect(screen.getByText('harassment')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unban' })).toBeNull()
    expect(screen.queryByText('Unban a deleted account by GitHub id')).toBeNull()
  })

  test('admins unban with a required reason and the list reloads', async () => {
    const api = setup('admin', { unban: async () => {} })
    await screen.findByText('troll')
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }))
    expect(await screen.findByText('A reason is required.')).toBeTruthy()
    expect(api.calls.some((c) => c.name === 'unban')).toBe(false)
    fireEvent.change(screen.getByLabelText('Reason for troll'), { target: { value: 'appeal ok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban' }))
    await waitFor(() => expect(api.calls.filter((c) => c.name === 'listBanned').length).toBe(2))
    expect(api.calls.find((c) => c.name === 'unban')!.args).toEqual(['t1', 'appeal ok'])
  })

  test('unban by GitHub id validates the number', async () => {
    const api = setup('admin', { unbanGithubId: async () => {} })
    await screen.findByText('troll')
    fireEvent.change(screen.getByLabelText('GitHub id'), { target: { value: 'abc' } })
    fireEvent.change(screen.getByLabelText('Reason for GitHub id'), { target: { value: 'why' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban GitHub id' }))
    expect(await screen.findByText('Enter a numeric GitHub id.')).toBeTruthy()
    expect(api.calls.some((c) => c.name === 'unbanGithubId')).toBe(false)
    fireEvent.change(screen.getByLabelText('GitHub id'), { target: { value: '4242' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban GitHub id' }))
    await waitFor(() => expect(api.calls.some((c) => c.name === 'unbanGithubId')).toBe(true))
    expect(api.calls.find((c) => c.name === 'unbanGithubId')!.args).toEqual([4242, 'why'])
  })

  test('not_found on the GitHub id shows the message', async () => {
    setup('admin', { unbanGithubId: async () => Promise.reject(new ApiError('not_found')) })
    await screen.findByText('troll')
    fireEvent.change(screen.getByLabelText('GitHub id'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Reason for GitHub id'), { target: { value: 'why' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unban GitHub id' }))
    expect(await screen.findByText('That GitHub id is not banned.')).toBeTruthy()
  })
})
