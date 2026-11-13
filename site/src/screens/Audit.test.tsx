import { describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthProvider } from '../auth.tsx'
import { ApiError, type ModAction, type Role } from '../api.ts'
import { errorText } from '../copy.ts'
import { fakeApi } from '../fake-api.ts'
import { Audit } from './Audit.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'm1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

const row = (id: number, over: Partial<ModAction> = {}): ModAction => ({
  id,
  actor_id: 'm9',
  target_id: 't1',
  action: 'mod_mute',
  reason: `reason ${id}`,
  details: { minutes: 10 },
  created_at: `2026-11-12T10:0${id}:00Z`,
  ...over,
})

function setup(over: Parameters<typeof fakeApi>[0] = {}, role: Role = 'moderator') {
  const api = fakeApi({
    listActions: async () => [row(2), row(1)],
    names: async () =>
      new Map<string, { nickname: string; role: Role }>([
        ['m9', { nickname: 'modmax', role: 'moderator' }],
        ['t1', { nickname: 'troll', role: 'user' }],
      ]),
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Audit api={api} role={role} pageSize={2} />
    </AuthProvider>,
  )
  return api
}

describe('audit', () => {
  test('audit shows system for a null actor', async () => {
    setup({ listActions: async () => [row(3, { actor_id: null, action: 'auto_mute', reason: null, details: { report_ids: [1, 2, 3] } })] })
    expect(await screen.findByText('system')).toBeTruthy()
    const table = within(screen.getByRole('table'))
    expect(table.getByText('auto_mute')).toBeTruthy()
    expect(table.getByText('report_ids: [1,2,3]')).toBeTruthy()
    expect(table.getByText('troll')).toBeTruthy()
    expect(screen.getByText('Actions are kept for 1 year.')).toBeTruthy()
  })

  test('shows actor, target, reason and details', async () => {
    setup()
    expect(await screen.findByText('reason 2')).toBeTruthy()
    expect(screen.getAllByText('modmax')).toHaveLength(2)
    expect(screen.getAllByText('minutes: 10')).toHaveLength(2)
  })

  test('GitHub ids and logins in old invite details show to admins only', async () => {
    const invite = () => [row(5, { action: 'admin_add_invite', target_id: null, reason: null, details: { github_id: 4242, github_login: 'octo', note: 'friend' } })]
    setup({ listActions: async () => invite() })
    expect(await screen.findByText('note: friend')).toBeTruthy()
    expect(screen.queryByText(/github_login/)).toBeNull()
    expect(screen.queryByText(/4242/)).toBeNull()
    cleanup()
    setup({ listActions: async () => invite() }, 'admin')
    expect(await screen.findByText('github_id: 4242, github_login: octo, note: friend')).toBeTruthy()
  })

  test('audit filter by action calls listActions with it', async () => {
    const api = setup()
    await screen.findByText('reason 2')
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'mod_ban' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await waitFor(() => expect(api.calls.filter((c) => c.name === 'listActions').at(-1)!.args[0]).toMatchObject({ action: 'mod_ban' }))
  })

  test('actor and target nicknames resolve via lookupUser', async () => {
    const api = setup({
      lookupUser: async (n: string) => ({ profile: { id: n === 'modmax' ? 'm9' : 't1' } }) as never,
    })
    await screen.findByText('reason 2')
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: '@ModMax' } })
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'troll' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    await waitFor(() =>
      expect(api.calls.filter((c) => c.name === 'listActions').at(-1)!.args[0]).toMatchObject({ actorId: 'm9', targetId: 't1' }),
    )
    expect(api.calls.filter((c) => c.name === 'lookupUser').map((c) => c.args[0])).toEqual(['modmax', 'troll'])
  })

  test('unknown nickname shows a message and does not query', async () => {
    const api = setup({ lookupUser: async () => Promise.reject(new ApiError('not_found')) })
    await screen.findByText('reason 2')
    const before = api.calls.filter((c) => c.name === 'listActions').length
    fireEvent.change(screen.getByLabelText('Actor'), { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    expect(await screen.findByText('No user with that nickname.')).toBeTruthy()
    expect(api.calls.filter((c) => c.name === 'listActions').length).toBe(before)
  })

  test('load more passes before = last row created_at and id', async () => {
    let n = 0
    const api = setup({ listActions: async () => (++n === 1 ? [row(2), row(1)] : [row(0)]) })
    await screen.findByText('reason 2')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('reason 0')
    const last = api.calls.filter((c) => c.name === 'listActions').at(-1)!
    expect(last.args[0]).toMatchObject({ before: { created_at: '2026-11-12T10:01:00Z', id: 1 } })
    expect(screen.getByText('reason 2')).toBeTruthy()
  })

  test('a failed names lookup shows unknown and an error', async () => {
    setup({ names: async () => Promise.reject(new ApiError('network')) })
    expect(await screen.findByText('reason 2')).toBeTruthy()
    expect(screen.getByText(errorText('network'))).toBeTruthy()
    expect(screen.queryByText('deleted user')).toBeNull()
    expect(screen.getAllByText('unknown').length).toBe(4)
  })

  test('load more disappears when the page is short', async () => {
    setup({ listActions: async () => [row(1)] })
    await screen.findByText('reason 1')
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})
