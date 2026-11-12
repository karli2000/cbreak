import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthProvider } from '../auth.tsx'
import { ApiError, type Role, type UserLookup } from '../api.ts'
import { errorText } from '../copy.ts'
import { fakeApi } from '../fake-api.ts'
import { Users } from './Users.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'm1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

function lookup(over: Partial<UserLookup['profile']> = {}): UserLookup {
  return {
    profile: {
      id: 't1',
      nickname: 'troll',
      role: 'user',
      github_created_at: '2024-03-05T00:00:00Z',
      created_at: '2026-10-01T12:00:00Z',
      muted_until: null,
      banned_at: null,
      ban_reason: null,
      ...over,
    },
    reports_against: [
      {
        id: 7,
        reporter_id: 'r1',
        message_id: 100,
        reason: 'spam links',
        snapshot: { message: null, context: [{ id: 100, nickname: 'troll', body: 'buy now', created_at: '2026-11-12T10:00:00Z' }] },
        status: 'open',
        handled_by: null,
        handled_at: null,
        created_at: '2026-11-12T10:05:00Z',
      },
    ],
    actions_against: [
      { id: 1, actor_id: 'm9', action: 'mod_mute', reason: 'earlier warning', details: {}, created_at: '2026-11-11T08:00:00Z' },
    ],
  }
}

function setup(role: Role = 'moderator', over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    lookupUser: async () => lookup(),
    names: async () => new Map([['m9', { nickname: 'modmax', role: 'moderator' as Role }]]),
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Users api={api} role={role} />
    </AuthProvider>,
  )
  return api
}

function search(text: string) {
  fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
}

describe('users', () => {
  test('lookup shows profile, reports and actions', async () => {
    setup()
    search('troll')
    expect(await screen.findByText('spam links')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /troll/ })).toBeTruthy()
    expect(screen.getByText('Not muted')).toBeTruthy()
    expect(screen.getByText('earlier warning')).toBeTruthy()
    expect(screen.getByText(/modmax/)).toBeTruthy()
    expect(screen.getByText('buy now')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mute 10m' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unban' })).toBeNull()
  })

  test('shows mute time, ban reason and unknown github age', async () => {
    const until = new Date(Date.now() + 3600_000)
    const hh = String(until.getHours()).padStart(2, '0')
    const mm = String(until.getMinutes()).padStart(2, '0')
    setup('admin', {
      lookupUser: async () => lookup({ muted_until: until.toISOString(), banned_at: '2026-11-12T09:00:00Z', ban_reason: 'harassment', github_created_at: null }),
    })
    search('troll')
    expect(await screen.findByText(new RegExp(`Muted until ${hh}:${mm}, \\d{1,2} [A-Z][a-z]{2}`))).toBeTruthy()
    expect(screen.getByText(/harassment/)).toBeTruthy()
    expect(screen.getByText(/unknown → slow mode/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unban' })).toBeTruthy()
  })

  test('a past mute counts as not muted', async () => {
    setup('moderator', { lookupUser: async () => lookup({ muted_until: '2020-01-01T00:00:00Z' }) })
    search('troll')
    expect(await screen.findByText('Not muted')).toBeTruthy()
  })

  test('lookup normalizes @Nick', async () => {
    const api = setup()
    search('  @Nick ')
    await waitFor(() => expect(api.calls.some((c) => c.name === 'lookupUser')).toBe(true))
    expect(api.calls.find((c) => c.name === 'lookupUser')!.args).toEqual(['nick'])
  })

  test('unknown nickname shows the message', async () => {
    setup('moderator', { lookupUser: async () => Promise.reject(new ApiError('not_found')) })
    search('nobody')
    expect(await screen.findByText('No user with that nickname.')).toBeTruthy()
  })

  test('a slow earlier lookup does not overwrite a later one', async () => {
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    setup('moderator', {
      lookupUser: async (n) => {
        if (n === 'slow') await slow
        return { ...lookup(), profile: { ...lookup().profile, nickname: n } }
      },
    })
    search('slow')
    search('fast')
    expect(await screen.findByRole('heading', { name: /fast/ })).toBeTruthy()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('heading', { name: /slow/ })).toBeNull()
    expect(screen.getByRole('heading', { name: /fast/ })).toBeTruthy()
  })

  test('forbidden action shows the rank message', async () => {
    const api = setup('moderator', { mute: async () => Promise.reject(new ApiError('forbidden')) })
    search('troll')
    await screen.findByText('spam links')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'because' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mute 10m' }))
    expect(await screen.findByText(errorText('forbidden'))).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Mute 10m' }) as HTMLButtonElement).disabled).toBe(false)
    expect(api.calls.filter((c) => c.name === 'mute').length).toBe(1)
  })

  test('a successful action re-runs the lookup', async () => {
    const api = setup('moderator', { mute: async () => {} })
    search('troll')
    await screen.findByText('spam links')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'because' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mute 10m' }))
    await waitFor(() => expect(api.calls.filter((c) => c.name === 'lookupUser').length).toBe(2))
  })

  test('ActionBar state does not carry over to another user', async () => {
    const api = setup('moderator', {
      lookupUser: async (n) => ({ ...lookup(), profile: { ...lookup().profile, id: `id-${n}`, nickname: n } }),
      ban: async () => {},
    })
    search('usera')
    await screen.findByRole('heading', { name: /usera/ })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'old reason' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    expect(screen.getByRole('button', { name: 'Confirm ban' })).toBeTruthy()
    search('userb')
    await screen.findByRole('heading', { name: /userb/ })
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    expect(api.calls.some((c) => c.name === 'ban')).toBe(false)
    expect((screen.getByLabelText('Reason') as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: 'Confirm ban' })).toBeNull()
  })

  test('profile still shows when names fails; empty query gives feedback', async () => {
    setup('moderator', { names: async () => Promise.reject(new ApiError('network')) })
    search('@')
    expect(await screen.findByText('Enter a nickname.')).toBeTruthy()
    search('troll')
    expect(await screen.findByText(/modmax|deleted user/)).toBeTruthy()
    expect(screen.getByText(/deleted user/)).toBeTruthy()
  })
})
