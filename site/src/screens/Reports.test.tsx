import { describe, expect, jest, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AuthProvider } from '../auth.tsx'
import { ARM_MS } from '../components/ActionBar.tsx'
import { ApiError, type Report, type Role } from '../api.ts'
import { COPY } from '../copy.ts'
import { fakeApi } from '../fake-api.ts'
import { Reports } from './Reports.tsx'

const client = {
  auth: {
    getSession: async () => ({ data: { session: { user: { id: 'm1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
} as unknown as SupabaseClient

function report(over: Partial<Report> = {}): Report {
  return {
    id: 7,
    reporter_id: 'r1',
    target_id: 't1',
    message_id: 100,
    room: 'lobby',
    instance: 1,
    reason: 'spam links',
    snapshot: {
      message: { id: 100, nickname: 'troll', body: 'buy now', created_at: '2026-11-12T10:00:00Z' },
      context: [
        { id: 99, nickname: 'lena', body: 'hello there', created_at: '2026-11-12T09:59:00Z' },
        { id: 100, nickname: 'troll', body: 'buy now', created_at: '2026-11-12T10:00:00Z' },
        { id: 101, nickname: 'lena', body: 'gone line', created_at: '2026-11-12T10:01:00Z', deleted: true },
      ],
    },
    status: 'open',
    handled_by: null,
    handled_at: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  }
}

const nameMap = () =>
  new Map<string, { nickname: string; role: Role }>([
    ['r1', { nickname: 'lena', role: 'user' }],
    ['t1', { nickname: 'troll', role: 'user' }],
  ])

function setup(over: Parameters<typeof fakeApi>[0] = {}, reports: Report[] = [report()]) {
  const api = fakeApi({
    listReports: async (status) => reports.filter((r) => r.status === status),
    names: async () => nameMap(),
    ...over,
  })
  render(
    <AuthProvider client={client}>
      <Reports api={api} />
    </AuthProvider>,
  )
  return api
}

const names = (api: ReturnType<typeof fakeApi>) => api.calls.map((c) => c.name)

describe('reports', () => {
  test('lists open reports with names and snapshot', async () => {
    setup()
    expect(await screen.findByText('spam links')).toBeTruthy()
    expect(screen.getByText('lena → troll')).toBeTruthy()
    expect(screen.getByText(/lobby · 1/)).toBeTruthy()
    expect(screen.getByText('hello there')).toBeTruthy()
    expect(screen.getByText('(deleted)')).toBeTruthy()
    expect(screen.getByText(COPY.retention)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  test('states how long resolved reports are kept', async () => {
    setup()
    expect(await screen.findByText('Resolved reports are kept 90 days.')).toBeTruthy()
    expect(COPY.resolvedRetention).toBe('Resolved reports are kept 90 days.')
  })

  test('a deleted account shows deleted user', async () => {
    setup({}, [report({ reporter_id: null })])
    expect(await screen.findByText('deleted user → troll')).toBeTruthy()
  })

  test('dismiss resolves and removes the item', async () => {
    const reports = [report()]
    const api = setup({
      resolveReport: async (id, status) => {
        reports.find((r) => r.id === id)!.status = status
      },
    }, reports)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('spam links')).toBeNull())
    expect(api.calls.find((c) => c.name === 'resolveReport')!.args).toEqual([7, 'dismissed'])
  })

  test('expired message: delete explains, resolve still works', async () => {
    const api = setup({
      deleteMessage: async () => {
        throw new ApiError('not_found')
      },
      resolveReport: async () => {},
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }))
    expect(await screen.findByText(COPY.expiredMessage)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mark actioned' }))
    await waitFor(() => expect(api.calls.some((c) => c.name === 'resolveReport')).toBe(true))
    expect(api.calls.find((c) => c.name === 'resolveReport')!.args).toEqual([7, 'actioned'])
  })

  test('mute 1h needs a reason', async () => {
    const api = setup({ mute: async () => {} })
    fireEvent.click(await screen.findByRole('button', { name: 'Mute 1h' }))
    expect(await screen.findByText('A reason is required.')).toBeTruthy()
    expect(names(api)).not.toContain('mute')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'spamming' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mute 1h' }))
    await waitFor(() => expect(names(api)).toContain('mute'))
    expect(api.calls.find((c) => c.name === 'mute')!.args).toEqual(['t1', 60, 'spamming'])
  })

  test('ban asks for confirmation', async () => {
    const api = setup({ ban: async () => {} })
    await screen.findByText('spam links')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'scam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    expect(names(api)).not.toContain('ban')
    // a click right after arming (a double-click) is ignored
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm ban' }))
    expect(names(api)).not.toContain('ban')
    await Bun.sleep(ARM_MS + 20)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ban' }))
    await waitFor(() => expect(names(api)).toContain('ban'))
    expect(api.calls.find((c) => c.name === 'ban')!.args).toEqual(['t1', 'scam'])
  })

  test('buttons are disabled while a call runs', async () => {
    let release: () => void = () => {}
    const api = setup({ mute: () => new Promise<void>((r) => (release = r)) })
    await screen.findByText('spam links')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } })
    const btn = screen.getByRole('button', { name: 'Mute 10m' }) as HTMLButtonElement
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(api.calls.filter((c) => c.name === 'mute').length).toBe(1)
    expect(btn.disabled).toBe(true)
    release()
    await waitFor(() => expect(btn.disabled).toBe(false))
  })

  test('snapshot content renders as text', async () => {
    const word = 'x'.repeat(280)
    const evil = '<img src=x onerror=alert(1)>'
    const r = report({
      snapshot: {
        message: null,
        context: [
          { id: 1, nickname: 'a', body: evil, created_at: '2026-11-12T10:00:00Z' },
          { id: 2, nickname: 'b', body: word, created_at: '2026-11-12T10:00:01Z' },
        ],
      },
      message_id: null,
    })
    setup({}, [r])
    expect(await screen.findByText(evil)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    const el = screen.getByText(word)
    expect(el.className).toContain('snap-body')
  })

  test('a slow old load cannot overwrite a newer filter', async () => {
    let releaseOpen: () => void = () => {}
    const open = [report()]
    const dismissed = [report({ id: 8, status: 'dismissed', reason: 'old one' })]
    const api = setup({
      listReports: (status) =>
        status === 'open' ? new Promise((r) => (releaseOpen = () => r(open))) : Promise.resolve(dismissed),
    })
    await waitFor(() => expect(names(api)).toContain('listReports'))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'dismissed' } })
    expect(await screen.findByText('old one')).toBeTruthy()
    releaseOpen()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('old one')).toBeTruthy()
    expect(screen.queryByText('spam links')).toBeNull()
    expect(api.calls.filter((c) => c.name === 'listReports').map((c) => c.args[0])).toEqual(['open', 'dismissed'])
  })

  test('buttons re-enable and the error shows when the reload fails', async () => {
    let n = 0
    setup({
      listReports: async () => {
        if (n++ === 0) return [report()]
        throw new ApiError('network')
      },
      resolveReport: async () => {},
    })
    const btn = (await screen.findByRole('button', { name: 'Dismiss' })) as HTMLButtonElement
    fireEvent.click(btn)
    expect(await screen.findByText("Can't reach the server. Check your connection.")).toBeTruthy()
    await waitFor(() => expect(btn.disabled).toBe(false))
    expect((screen.getByRole('button', { name: 'Mark actioned' }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('a report with a deleted target has no ActionBar but resolves', async () => {
    const api = setup({ resolveReport: async () => {} }, [report({ target_id: null, message_id: null })])
    await screen.findByText('spam links')
    expect(screen.queryByLabelText('Reason')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mark actioned' }))
    await waitFor(() => expect(names(api)).toContain('resolveReport'))
  })

  test('ban confirmation expires after 5 s', async () => {
    jest.useFakeTimers()
    try {
      const api = setup({ ban: async () => {} })
      await screen.findByText('spam links')
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'scam' } })
      fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
      expect(screen.getByRole('button', { name: 'Confirm ban' })).toBeTruthy()
      await act(async () => {
        jest.advanceTimersByTime(5100)
      })
      expect(screen.queryByRole('button', { name: 'Confirm ban' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
      expect(names(api)).not.toContain('ban')
    } finally {
      jest.useRealTimers()
    }
  })
})
