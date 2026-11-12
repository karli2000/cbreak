import { describe, expect, mock, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { App } from './App.tsx'
import { ApiError, type Me } from './api.ts'
import { fakeApi } from './fake-api.ts'

function fakeClient(signedIn: boolean, oauthError: string | null = null) {
  const signInWithOAuth = mock(async (_o: unknown) => ({ data: {}, error: oauthError ? { message: oauthError } : null }))
  const signOut = mock(async (_o?: unknown) => ({ error: null }))
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

  test('shows an error when sign-in fails to start', async () => {
    const { client } = fakeClient(false, 'network')
    render(<App client={client} api={fakeApi()} />)
    ;(await screen.findByRole('button', { name: 'Sign in with GitHub' })).click()
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach the server. Check your connection.")
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

  test('a failed profile load offers Retry, which loads it again', async () => {
    const { client } = fakeClient(true)
    let n = 0
    const api = fakeApi({
      me: async () => {
        if (n++ === 0) throw new ApiError('network')
        return staff('moderator')
      },
      listReports: async () => [],
    })
    render(<App client={client} api={api} />)
    expect((await screen.findByRole('alert')).textContent).toBe("Can't reach the server. Check your connection.")
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    ;(await screen.findByRole('button', { name: 'Retry' })).click()
    expect(await screen.findByText('☕ Coffee Break moderation · karli (moderator)')).toBeTruthy()
    expect(api.calls.filter((c) => c.name === 'me')).toHaveLength(2)
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

  test('changing the hash switches the tab live', async () => {
    const { client } = fakeClient(true)
    render(<App client={client} api={fakeApi({ me: async () => staff('moderator'), listReports: async () => [] })} />)
    await screen.findByRole('link', { name: 'Users' })
    expect(screen.getByRole('link', { name: 'Reports' }).getAttribute('aria-current')).toBe('page')
    act(() => {
      window.location.hash = '#users'
      window.dispatchEvent(new window.Event('hashchange'))
    })
    await waitFor(() => expect(screen.getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBe('page'))
    expect(screen.getByRole('link', { name: 'Reports' }).getAttribute('aria-current')).toBeNull()
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
    // local only: a global sign-out would also end the moderator's coffeebreakd session
    expect(signOut.mock.calls.every((c) => JSON.stringify(c) === JSON.stringify([{ scope: 'local' }]))).toBe(true)
  })

  test('the Sign out button signs out locally only', async () => {
    const { client, signOut } = fakeClient(true)
    render(<App client={client} api={fakeApi({ me: async () => staff('moderator'), listReports: async () => [] })} />)
    ;(await screen.findByRole('button', { name: 'Sign out' })).click()
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy()
    expect(signOut.mock.calls).toEqual([[{ scope: 'local' }]])
  })
})
