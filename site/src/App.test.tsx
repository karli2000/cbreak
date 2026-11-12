import { describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { App } from './App.tsx'
import { ApiError, type Me } from './api.ts'
import { fakeApi } from './fake-api.ts'

function fakeClient(signedIn: boolean) {
  const signInWithOAuth = mock(async (_o: unknown) => ({ data: {}, error: null }))
  const signOut = mock(async () => ({ error: null }))
  const session = signedIn ? { user: { id: 'u1' } } : null
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithOAuth,
      signOut,
    },
  } as unknown as SupabaseClient
  return { client, signInWithOAuth, signOut }
}

const staff = (role: Me['role'], banned = false): Me => ({ id: 'u1', nickname: 'karli', role, banned })

describe('gate', () => {
  test('signed out shows the GitHub button', async () => {
    const { client, signInWithOAuth } = fakeClient(false)
    const api = fakeApi()
    render(<App client={client} api={api} />)
    const btn = await screen.findByRole('button', { name: 'Sign in with GitHub' })
    btn.click()
    expect(signInWithOAuth).toHaveBeenCalledTimes(1)
    const arg = signInWithOAuth.mock.calls[0]![0] as { provider: string; options: { redirectTo: string } }
    expect(arg.provider).toBe('github')
    expect(arg.options.redirectTo).toBe(window.location.origin + window.location.pathname)
    expect(api.calls).toEqual([])
  })

  test('refuses users and banned staff without loading data', async () => {
    for (const [me, text] of [
      [null, "You're not a moderator."],
      [staff('user'), "You're not a moderator."],
      [staff('moderator', true), 'Your account is banned.'],
    ] as const) {
      const { client } = fakeClient(true)
      const api = fakeApi({ me: async () => me })
      const { unmount } = render(<App client={client} api={api} />)
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
      expect(api.calls.map((c) => c.name)).toEqual(['me'])
      unmount()
    }
  })

  test('moderator sees the tabs without Admin; admin sees Admin', async () => {
    for (const role of ['moderator', 'admin'] as const) {
      const { client } = fakeClient(true)
      const api = fakeApi({ me: async () => staff(role), listReports: async () => [] })
      const { unmount } = render(<App client={client} api={api} />)
      expect(await screen.findByText(`☕ Coffee Break moderation · karli (${role})`)).toBeTruthy()
      for (const n of ['Reports', 'Live', 'Users', 'Bans', 'Audit']) expect(screen.getByRole('link', { name: n })).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Admin' }) !== null).toBe(role === 'admin')
      unmount()
    }
  })

  test('hash selects the tab', async () => {
    window.location.hash = '#audit'
    const { client } = fakeClient(true)
    const mod = fakeApi({ me: async () => staff('moderator'), listReports: async () => [] })
    const first = render(<App client={client} api={mod} />)
    await screen.findByRole('link', { name: 'Audit' })
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page')
    first.unmount()

    window.location.hash = '#admin'
    render(<App client={client} api={mod} />)
    await screen.findByRole('link', { name: 'Reports' })
    expect(screen.getByRole('link', { name: 'Reports' }).getAttribute('aria-current')).toBe('page')
  })

  test('an expired session returns to sign-in', async () => {
    const { client, signOut } = fakeClient(true)
    const api = fakeApi({
      me: async () => staff('moderator'),
      listReports: async () => {
        throw new ApiError('not_authenticated')
      },
    })
    render(<App client={client} api={api} />)
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy()
    await waitFor(() => expect(signOut).toHaveBeenCalled())
  })
})
