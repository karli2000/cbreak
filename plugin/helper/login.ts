// GitHub login through Supabase Auth (PKCE) with a one-shot 127.0.0.1 callback server. Approach from spike S3 (spikes/FINDINGS.md).
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { snapshotPkce } from './auth'
import { existsSync, readFileSync } from 'node:fs'

export function browserCommand(url: string, platform: NodeJS.Platform, isWsl: boolean): [string, string[]] {
  if (isWsl) return ['powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`]]
  if (platform === 'darwin') return ['open', [url]]
  return ['xdg-open', [url]]
}

function detectWsl(): boolean {
  try {
    return existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Opens the system browser; a no-op with CBREAK_NO_BROWSER=1. Failures are ignored (the URL is also emitted). */
export function openBrowser(url: string): void {
  if (process.env.CBREAK_NO_BROWSER === '1') return
  try {
    const [cmd, args] = browserCommand(url, process.platform, detectWsl())
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

/** Code exchanges one login tries before giving up (a real callback needs one). */
const MAX_EXCHANGES = 3

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const page = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>cbreak</title><h2>${body}</h2>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

export async function startLogin(
  client: SupabaseClient,
  opts: { open: (url: string) => void; timeoutMs: number },
): Promise<{ url: string; done: Promise<Session> }> {
  let settle!: (r: { ok: true; session: Session } | { ok: false; error: Error }) => void
  const outcome = new Promise<{ ok: true; session: Session } | { ok: false; error: Error }>((r) => (settle = r))
  let settled = false
  const finish: typeof settle = (r) => {
    if (settled) return
    settled = true
    settle(r)
  }

  // The callback carries a nonce only this login knows (`?n=`), so a request from another local
  // process or a web page that found the port cannot end, flood or substitute the login. Supabase
  // sends the browser back to the redirect URL with its query intact.
  const nonce = crypto.randomUUID().replace(/-/g, '')
  let exchanges = 0
  let restorePkce: () => void = () => {}
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname !== '/callback' || u.searchParams.get('n') !== nonce) return new Response('not found', { status: 404 })
      if (settled) return page('Login failed: this login is no longer active.', 410)
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error_description') ?? u.searchParams.get('error')
      if (err && !code) {
        finish({ ok: false, error: new Error(err) })
        return page(`Login failed: ${escapeHtml(err)}`)
      }
      // a stray request (no code, no error) or a code that does not exchange must not end a pending login
      if (!code) return page('Login failed: no code in this request.', 400)
      if (++exchanges > MAX_EXCHANGES) {
        finish({ ok: false, error: new Error('too many callback attempts') })
        return page('Login failed: too many attempts.', 429)
      }
      const { data, error } = await client.auth.exchangeCodeForSession(code)
      if (error || !data.session) {
        restorePkce() // a stray code must not consume the verifier the real callback needs
        return page(`Login failed: ${escapeHtml(error?.message ?? 'no session')}`, 400)
      }
      finish({ ok: true, session: data.session })
      return page('☕ Signed in to cbreak. You can close this tab.')
    },
  })

  const timer = setTimeout(() => finish({ ok: false, error: new Error('login timed out') }), opts.timeoutMs)
  const stop = () => {
    clearTimeout(timer)
    void server.stop() // graceful: the callback response still goes out
  }

  try {
    const redirectTo = `http://127.0.0.1:${server.port}/callback?n=${nonce}`
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo, skipBrowserRedirect: true },
    })
    if (error || !data.url) throw error ?? new Error('no oauth url')
    restorePkce = snapshotPkce(client)
    const done = outcome.then((r) => {
      stop()
      if (!r.ok) throw r.error
      return r.session
    })
    done.catch(() => {}) // callers attach their own handler; never an unhandled rejection
    opts.open(data.url)
    return { url: data.url, done }
  } catch (e) {
    stop()
    throw e
  }
}
