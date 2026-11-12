import { expect, test } from 'bun:test'
import { browserCommand } from '../../plugin/helper/login'

test('WSL opens the browser through powershell and doubles single quotes', () => {
  expect(browserCommand('https://x/?a=1', 'linux', true)).toEqual([
    'powershell.exe',
    ['-NoProfile', '-Command', "Start-Process 'https://x/?a=1'"],
  ])
  expect(browserCommand("https://x/?a='b", 'linux', true)[1][2]).toBe("Start-Process 'https://x/?a=''b'")
})

test('darwin uses open, linux uses xdg-open', () => {
  expect(browserCommand('https://x', 'darwin', false)).toEqual(['open', ['https://x']])
  expect(browserCommand('https://x', 'linux', false)).toEqual(['xdg-open', ['https://x']])
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { startLogin } from '../../plugin/helper/login'

const fake = (exchange: () => Promise<unknown>) =>
  ({
    auth: {
      signInWithOAuth: async ({ options }: { options: { redirectTo: string } }) => ({
        data: { url: `https://auth.example/authorize?redirect_to=${encodeURIComponent(options.redirectTo)}` },
        error: null,
      }),
      exchangeCodeForSession: exchange,
    },
  }) as unknown as SupabaseClient

test('startLogin resolves with the exchanged session', async () => {
  const session = { access_token: 'a' }
  const opened: string[] = []
  const { url, done } = await startLogin(fake(async () => ({ data: { session }, error: null })), {
    open: (u) => void opened.push(u),
    timeoutMs: 5000,
  })
  expect(opened).toEqual([url])
  const redirect = new URL(url).searchParams.get('redirect_to')!
  const page = await (await fetch(`${redirect}?code=abc`)).text()
  expect(page).toContain('Signed in to Coffee Break')
  expect(await done).toBe(session as never)
})

test('startLogin rejects on timeout', async () => {
  const { done } = await startLogin(fake(async () => ({ data: {}, error: null })), { open: () => {}, timeoutMs: 30 })
  await expect(done).rejects.toThrow('login timed out')
})
