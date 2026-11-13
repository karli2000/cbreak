import { expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHelperClient } from '../../plugin/helper/auth'
import { startLogin } from '../../plugin/helper/login'
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
  expect(page).toContain('Signed in to cbreak')
  expect(await done).toBe(session as never)
})

test('startLogin rejects on timeout', async () => {
  const { done } = await startLogin(fake(async () => ({ data: {}, error: null })), { open: () => {}, timeoutMs: 30 })
  await expect(done).rejects.toThrow('login timed out')
})

test('a bad code does not consume the PKCE verifier; the real callback still signs in', async () => {
  // mimics auth-js: signInWithOAuth stores the verifier, every exchange removes it, only a good code succeeds
  const client = createHelperClient('http://127.0.0.1:1', 'k')
  const storage = (client.auth as unknown as { storage: Storage }).storage
  const session = { access_token: 'a' }
  client.auth.signInWithOAuth = (async ({ options }: { options: { redirectTo: string } }) => {
    await storage.setItem('sb-x-code-verifier', 'verifier')
    return { data: { url: `https://auth.example/?redirect_to=${encodeURIComponent(options.redirectTo)}` }, error: null }
  }) as never
  client.auth.exchangeCodeForSession = (async (code: string) => {
    const v = await storage.getItem('sb-x-code-verifier')
    await storage.removeItem('sb-x-code-verifier')
    return v && code === 'good' ? { data: { session }, error: null } : { data: {}, error: new Error('bad') }
  }) as never
  const { url, done } = await startLogin(client, { open: () => {}, timeoutMs: 5000 })
  const redirect = new URL(url).searchParams.get('redirect_to')!
  expect((await fetch(`${redirect}?code=bogus`)).status).toBe(400)
  expect((await fetch(`${redirect}?code=good`)).status).toBe(200)
  expect(await done).toBe(session as never)
})
