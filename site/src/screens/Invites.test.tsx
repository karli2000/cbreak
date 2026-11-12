import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { App } from '../App.tsx'
import { AuthProvider } from '../auth.tsx'
import { ApiError, type Role } from '../api.ts'
import { errorText } from '../copy.ts'
import { fakeApi } from '../fake-api.ts'
import { Admin } from './Admin.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'a1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

const INVITES = [{ github_id: 7, github_login: 'lena', note: 'friend', created_at: '2026-11-13T10:00:00Z' }]

function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    listStaff: async () => [{ id: 'a1', nickname: 'boss', role: 'admin' as Role }],
    listRooms: async () => [],
    listFilters: async () => [],
    listInvites: async () => INVITES,
    inviteOnly: async () => true,
    setInviteOnly: async () => {},
    addInvite: async () => {},
    removeInvite: async () => {},
    githubUser: async (login: string) => ({ id: 1, login }),
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Admin api={api} />
    </AuthProvider>,
  )
  return api
}
const callsOf = (api: ReturnType<typeof setup>, name: string) => api.calls.filter((c) => c.name === name)
const section = () => screen.findByRole('region', { name: 'Invites' })

describe('admin invites', () => {
  test('admin adds an invite by GitHub username', async () => {
    const api = setup({ githubUser: async () => ({ id: 1, login: 'Octo' }) })
    const s = within(await section())
    fireEvent.change(s.getByLabelText('GitHub username'), { target: { value: ' @octo ' } })
    fireEvent.click(s.getByRole('button', { name: 'Add invite' }))
    await waitFor(() => expect(callsOf(api, 'addInvite')[0]?.args).toEqual([1, 'Octo', null]))
    expect(callsOf(api, 'githubUser')[0]?.args).toEqual(['octo'])
    await waitFor(() => expect(callsOf(api, 'listInvites').length).toBe(2))
  })

  test('the note is passed along', async () => {
    const api = setup()
    const s = within(await section())
    fireEvent.change(s.getByLabelText('GitHub username'), { target: { value: 'octo' } })
    fireEvent.change(s.getByLabelText('Note'), { target: { value: 'my friend' } })
    fireEvent.click(s.getByRole('button', { name: 'Add invite' }))
    await waitFor(() => expect(callsOf(api, 'addInvite')[0]?.args).toEqual([1, 'octo', 'my friend']))
  })

  test('an empty username is rejected locally', async () => {
    const api = setup()
    const s = within(await section())
    fireEvent.change(s.getByLabelText('GitHub username'), { target: { value: ' @ ' } })
    fireEvent.click(s.getByRole('button', { name: 'Add invite' }))
    expect(await screen.findByText(errorText('invalid_login'))).toBeTruthy()
    expect(callsOf(api, 'githubUser').length).toBe(0)
  })

  test('unknown GitHub username shows a message and adds nothing', async () => {
    const api = setup({ githubUser: async () => Promise.reject(new ApiError('github_not_found')) })
    const s = within(await section())
    fireEvent.change(s.getByLabelText('GitHub username'), { target: { value: 'nobody' } })
    fireEvent.click(s.getByRole('button', { name: 'Add invite' }))
    expect(await screen.findByText('No GitHub account with that name.')).toBeTruthy()
    expect(callsOf(api, 'addInvite').length).toBe(0)
  })

  test('rate-limited lookup shows the rate message', async () => {
    setup({ githubUser: async () => Promise.reject(new ApiError('github_rate_limited')) })
    const s = within(await section())
    fireEvent.change(s.getByLabelText('GitHub username'), { target: { value: 'octo' } })
    fireEvent.click(s.getByRole('button', { name: 'Add invite' }))
    expect(await screen.findByText('GitHub is rate-limiting lookups. Try again in a few minutes.')).toBeTruthy()
  })

  test('turning invite-only off needs confirmation', async () => {
    const api = setup()
    const s = within(await section())
    fireEvent.click(await s.findByRole('button', { name: 'Invite-only: on' }))
    expect(callsOf(api, 'setInviteOnly').length).toBe(0)
    fireEvent.click(await s.findByRole('button', { name: 'Confirm: anyone with a GitHub account can join' }))
    await waitFor(() => expect(callsOf(api, 'setInviteOnly')[0]?.args).toEqual([false]))
    expect(await s.findByRole('button', { name: 'Invite-only: off' })).toBeTruthy()
  })

  test('turning invite-only on needs no confirmation', async () => {
    const api = setup({ inviteOnly: async () => false })
    const s = within(await section())
    fireEvent.click(await s.findByRole('button', { name: 'Invite-only: off' }))
    await waitFor(() => expect(callsOf(api, 'setInviteOnly')[0]?.args).toEqual([true]))
  })

  test('lists invites with a GitHub link; remove calls removeInvite and reloads', async () => {
    const api = setup()
    const s = within(await section())
    const link = (await s.findByRole('link', { name: 'lena' })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://github.com/lena')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(s.getByText('friend')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(callsOf(api, 'removeInvite')[0]?.args).toEqual([7]))
    await waitFor(() => expect(callsOf(api, 'listInvites').length).toBe(2))
  })
})

test('moderators do not see the Invites section', async () => {
  window.location.hash = '#admin'
  const api = fakeApi({
    me: async () => ({ id: 'u1', nickname: 'karli', role: 'moderator' as const, banned: false }),
    listReports: async () => [],
    listInvites: async () => INVITES,
  })
  render(<App client={client} api={api} />)
  await screen.findByText('☕ Coffee Break moderation · karli (moderator)')
  expect(screen.queryByRole('region', { name: 'Invites' })).toBeNull()
  expect(api.calls.some((c) => c.name === 'listInvites')).toBe(false)
  window.location.hash = ''
})
