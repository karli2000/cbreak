import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
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

function setup(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    listStaff: async () => [
      { id: 'a1', nickname: 'boss', role: 'admin' as Role },
      { id: 'm1', nickname: 'modmax', role: 'moderator' as Role },
    ],
    listRooms: async () => [{ slug: 'lobby', title: 'Lobby', kind: 'public', lang: null, is_open: true }],
    listFilters: async () => [{ id: 5, pattern: 'bad\\s+word', created_at: '2026-11-01T00:00:00Z' }],
    setRole: async () => {},
    upsertRoom: async () => {},
    addFilter: async () => 6,
    removeFilter: async () => {},
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

describe('admin staff', () => {
  test('admin sets a role', async () => {
    const api = setup()
    const sel = await screen.findByLabelText('Role of modmax')
    fireEvent.change(sel, { target: { value: 'user' } })
    await waitFor(() => expect(callsOf(api, 'setRole')[0]?.args).toEqual(['m1', 'user']))
    await waitFor(() => expect(callsOf(api, 'listStaff').length).toBe(2))
  })

  test('a failed role change shows the error', async () => {
    setup({ setRole: async () => Promise.reject(new ApiError('forbidden')) })
    fireEvent.change(await screen.findByLabelText('Role of modmax'), { target: { value: 'user' } })
    expect(await screen.findByText(errorText('forbidden'))).toBeTruthy()
  })

  test('admin rows, including your own, are read-only', async () => {
    setup()
    await screen.findByLabelText('Role of modmax')
    expect(screen.queryByLabelText('Role of boss')).toBeNull()
    const row = within(screen.getByRole('region', { name: 'Staff' })).getByText('boss').closest('li') as HTMLElement
    expect(within(row).getByText('admin')).toBeTruthy()
    expect(within(row).queryByRole('combobox')).toBeNull()
  })

  test('making someone admin needs a confirmation', async () => {
    const api = setup()
    fireEvent.change(await screen.findByLabelText('Role of modmax'), { target: { value: 'admin' } })
    expect(callsOf(api, 'setRole')).toHaveLength(0)
    expect(screen.getByText("Admins can't be changed from this site afterwards.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make modmax admin' }))
    await waitFor(() => expect(callsOf(api, 'setRole')[0]?.args).toEqual(['m1', 'admin']))
    await waitFor(() => expect(callsOf(api, 'listStaff').length).toBe(2))
  })

  test('cancelling the admin confirmation changes nothing', async () => {
    const api = setup()
    fireEvent.change(await screen.findByLabelText('Role of modmax'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Make modmax admin' })).toBeNull()
    expect((screen.getByLabelText('Role of modmax') as HTMLSelectElement).value).toBe('moderator')
    expect(callsOf(api, 'setRole')).toHaveLength(0)
  })

  test('add moderator looks up then sets moderator', async () => {
    const api = setup({ lookupUser: async () => ({ profile: { id: 'u7', nickname: 'newbie' } }) as never })
    await screen.findByLabelText('Role of modmax')
    fireEvent.change(screen.getByLabelText('Add moderator'), { target: { value: '@Newbie' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add moderator' }))
    await waitFor(() => expect(callsOf(api, 'setRole')[0]?.args).toEqual(['u7', 'moderator']))
    expect(callsOf(api, 'lookupUser')[0]!.args).toEqual(['newbie'])
    await waitFor(() => expect(callsOf(api, 'listStaff').length).toBe(2))
  })

  test('add moderator with an unknown nickname', async () => {
    const api = setup({ lookupUser: async () => Promise.reject(new ApiError('not_found')) })
    await screen.findByLabelText('Role of modmax')
    fireEvent.change(screen.getByLabelText('Add moderator'), { target: { value: 'ghost' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add moderator' }))
    expect(await screen.findByText('No user with that nickname.')).toBeTruthy()
    expect(callsOf(api, 'setRole')).toHaveLength(0)
  })
})

describe('admin rooms', () => {
  test('save sends the edited row', async () => {
    const api = setup()
    fireEvent.change(await screen.findByLabelText('Title of lobby'), { target: { value: 'Main lobby' } })
    fireEvent.change(screen.getByLabelText('Language of lobby'), { target: { value: 'de' } })
    fireEvent.click(screen.getByLabelText('Open lobby'))
    fireEvent.click(screen.getByRole('button', { name: 'Save lobby' }))
    await waitFor(() =>
      expect(callsOf(api, 'upsertRoom')[0]?.args[0]).toEqual({ slug: 'lobby', title: 'Main lobby', kind: 'public', lang: 'de', is_open: false }),
    )
  })

  test('empty language saves as null', async () => {
    const api = setup({ listRooms: async () => [{ slug: 'lobby', title: 'Lobby', kind: 'public', lang: 'en', is_open: true }] })
    fireEvent.change(await screen.findByLabelText('Language of lobby'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save lobby' }))
    await waitFor(() => expect((callsOf(api, 'upsertRoom')[0]?.args[0] as { lang: unknown }).lang).toBeNull())
  })

  test('room slug is validated before saving', async () => {
    const api = setup()
    await screen.findByLabelText('Title of lobby')
    fireEvent.change(screen.getByLabelText('New room slug'), { target: { value: 'Bad Slug' } })
    fireEvent.change(screen.getByLabelText('New room title'), { target: { value: 'T' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    expect(await screen.findByText('Room names are 2–32 characters: a–z, 0–9 and -.')).toBeTruthy()
    expect(callsOf(api, 'upsertRoom')).toHaveLength(0)
  })

  test('a valid new room is created and the list reloads', async () => {
    const api = setup()
    await screen.findByLabelText('Title of lobby')
    fireEvent.change(screen.getByLabelText('New room slug'), { target: { value: 'dev-talk' } })
    fireEvent.change(screen.getByLabelText('New room title'), { target: { value: 'Dev talk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    await waitFor(() =>
      expect(callsOf(api, 'upsertRoom')[0]?.args[0]).toEqual({ slug: 'dev-talk', title: 'Dev talk', kind: 'public', lang: null, is_open: true }),
    )
    await waitFor(() => expect(callsOf(api, 'listRooms').length).toBe(2))
  })
})

describe('admin word filter', () => {
  test('shows patterns and the note', async () => {
    setup()
    expect(await screen.findByText('bad\\s+word')).toBeTruthy()
    expect(screen.getByText('Patterns are case-insensitive regular expressions.')).toBeTruthy()
  })

  test('invalid pattern shows the error', async () => {
    setup({ addFilter: async () => Promise.reject(new ApiError('invalid_pattern')) })
    await screen.findByText('bad\\s+word')
    fireEvent.change(screen.getByLabelText('Add pattern'), { target: { value: '(' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add pattern' }))
    expect(await screen.findByText(errorText('invalid_pattern'))).toBeTruthy()
  })

  test('add pattern reloads the list and clears the field', async () => {
    const api = setup()
    await screen.findByText('bad\\s+word')
    fireEvent.change(screen.getByLabelText('Add pattern'), { target: { value: 'spam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add pattern' }))
    await waitFor(() => expect(callsOf(api, 'addFilter')[0]?.args).toEqual(['spam']))
    await waitFor(() => expect(callsOf(api, 'listFilters').length).toBe(2))
    expect((screen.getByLabelText('Add pattern') as HTMLInputElement).value).toBe('')
  })

  test('remove filter calls removeFilter', async () => {
    const api = setup()
    await screen.findByText('bad\\s+word')
    const list = screen.getByRole('region', { name: 'Word filter' })
    fireEvent.click(within(list).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(callsOf(api, 'removeFilter')[0]?.args).toEqual([5]))
    await waitFor(() => expect(callsOf(api, 'listFilters').length).toBe(2))
  })
})
