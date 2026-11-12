import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SUPABASE_URL } from '../shared/backend'
import type { AuthState, Role } from '../shared/protocol'
import { CoffeeError, rpc } from './rpc'

const LOCK_RETRY_MS = 100
const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

/**
 * The login file for a backend: `auth.json` for the hosted project, `auth-<host>.json` for any other
 * (a dev run against a local stack must never read, refresh or delete the hosted login).
 */
export function authFileName(url: string): string {
  const origin = new URL(url).origin
  if (origin === new URL(SUPABASE_URL).origin) return 'auth.json'
  return `auth-${new URL(url).host.toLowerCase().replace(/[^a-z0-9.-]/g, '_')}.json`
}

export class AuthStore {
  private file: string
  private lock: string
  private url: string
  constructor(
    private dataDir: string,
    url: string = SUPABASE_URL,
  ) {
    this.url = new URL(url).origin
    this.file = join(dataDir, authFileName(url))
    this.lock = join(dataDir, 'auth.lock')
  }

  private async ensureDir() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.dataDir, 0o700)
  }

  async read(): Promise<Session | null> {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8'))
      // a file of another backend reads as signed out and is left alone
      if (j?.version !== 1 || !j.session || j.url !== this.url) return null
      return j.session as Session
    } catch {
      return null
    }
  }

  async write(s: Session): Promise<void> {
    await this.ensureDir()
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, url: this.url, session: s }), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true })
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir()
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await mkdir(this.lock)
        break
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e
        try {
          if (Date.now() - (await stat(this.lock)).mtimeMs > LOCK_STALE_MS) {
            await rm(this.lock, { recursive: true, force: true })
            continue
          }
        } catch {
          continue // lock vanished, retry immediately
        }
        if (Date.now() > deadline) throw new CoffeeError('lock_timeout')
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS))
      }
    }
    try {
      return await fn()
    } finally {
      await rm(this.lock, { recursive: true, force: true })
    }
  }
}

// Per-client in-memory storage, so the session can be read without supabase-js refreshing it
// (auth.getSession() refreshes an expired session outside our lock and never persists it).
const storages = new WeakMap<object, Map<string, string>>()

/** The client's current session exactly as stored, never triggering a refresh. */
export async function peekSession(client: SupabaseClient): Promise<Session | null> {
  const mem = storages.get(client)
  if (!mem) return (await client.auth.getSession()).data.session
  for (const [k, v] of mem) {
    if (!k.endsWith('-auth-token')) continue
    try {
      const s = JSON.parse(v)
      if (s?.access_token && s?.refresh_token) return s as Session
    } catch {}
  }
  return null
}

/** Snapshots the client's PKCE verifier entries; the returned function puts them back (auth-js deletes them even after a failed exchange). */
export function snapshotPkce(client: SupabaseClient): () => void {
  const mem = storages.get(client)
  if (!mem) return () => {}
  const saved = [...mem].filter(([k]) => k.includes('code-verifier'))
  return () => {
    for (const [k, v] of saved) mem.set(k, v)
  }
}

type AuthErr = { name?: string; status?: number; code?: string; message?: string }

/** Revoked/invalid token (4xx except 429): drop the login. Retryable (5xx, 429, network, unknown): keep the file. */
async function failRefresh(store: AuthStore, error: AuthErr): Promise<null> {
  const st = error.status
  const invalid =
    error.name !== 'AuthRetryableFetchError' &&
    ((typeof st === 'number' && st >= 400 && st < 500 && st !== 429) ||
      ['refresh_token_not_found', 'refresh_token_already_used', 'invalid_grant', 'session_not_found'].includes(error.code ?? ''))
  if (!invalid) throw new CoffeeError('network', error.message)
  await store.clear()
  return null
}

const nowS = () => Math.floor(Date.now() / 1000)

/** auth-js refreshes on its own when a token expires within 90 s (EXPIRY_MARGIN_MS); keep 30 s of slack. */
const SELF_REFRESH_S = 120

/**
 * Whether supabase-js can use the session without refreshing it on its own (outside the store lock,
 * never persisted). Used where a refresh is not affordable, e.g. the best-effort leave_room on shutdown.
 */
export function usableWithoutRefresh(s: Session, nowMs = Date.now()): boolean {
  return (s.expires_at ?? 0) * 1000 - nowMs > SELF_REFRESH_S * 1000
}
const fresh = (s: Session | null | undefined, marginS: number): boolean =>
  !!s && (s.expires_at ?? 0) > nowS() + marginS

/**
 * Keeps the client's session fresh. Refreshes are serialized across processes by the store lock;
 * a process that finds a newer session in the file adopts it instead of refreshing again
 * (refresh tokens rotate, so a second refresh would invalidate the first process's token).
 */
export async function ensureFreshSession(
  client: SupabaseClient,
  store: AuthStore,
  marginS: number,
): Promise<Session | null> {
  const current = await peekSession(client)
  if (current && fresh(current, marginS)) return current

  return store.withLock(async () => {
    const onDisk = await store.read()
    // adopt if fresh, or if another process already rotated the token (newer than ours)
    const newer =
      !!onDisk &&
      (!current || (onDisk.refresh_token !== current.refresh_token && (onDisk.expires_at ?? 0) >= (current.expires_at ?? 0)))
    if (onDisk && (fresh(onDisk, marginS) || newer)) {
      if (current?.access_token !== onDisk.access_token) {
        const { error } = await client.auth.setSession({
          access_token: onDisk.access_token,
          refresh_token: onDisk.refresh_token,
        })
        if (error) return failRefresh(store, error)
        // setSession refreshes an expired access token itself: persist whatever the client ended up with
        const actual = (await client.auth.getSession()).data.session
        if (actual && actual.access_token !== onDisk.access_token) {
          await store.write(actual)
          await client.realtime.setAuth(actual.access_token)
          return actual
        }
        await client.realtime.setAuth(onDisk.access_token)
      }
      return onDisk
    }
    // spend the newest refresh token we know of: memory can be ahead of the file after a refresh
    // supabase-js did on its own; persist it first, so a failed refresh never leaves a spent token on disk
    const base = !onDisk || (current && (current.expires_at ?? 0) > (onDisk.expires_at ?? 0)) ? current : onDisk
    const refresh_token = base?.refresh_token
    if (!refresh_token) return null
    if (base !== onDisk) await store.write(base!)
    const { data, error } = await client.auth.refreshSession({ refresh_token })
    if (error) return failRefresh(store, error)
    if (!data.session) return failRefresh(store, { status: 500, message: 'no session returned' })
    await store.write(data.session)
    await client.realtime.setAuth(data.session.access_token)
    return data.session
  })
}

/**
 * Persists every session supabase-js reports as refreshed or signed in, so a refresh it does on its
 * own (outside ensureFreshSession) still reaches the file and the next process never reads a spent token.
 */
export function persistRefreshes(client: SupabaseClient, store: AuthStore): void {
  client.auth.onAuthStateChange((event, session) => {
    if ((event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') || !session) return
    // never await inside the callback (auth-js holds its lock while notifying)
    setTimeout(() => void store.write(session).catch(() => {}), 0)
  })
}

type Profile = {
  nickname: string
  role: Role
  muted_until: string | null
  banned_at: string | null
  ban_reason: string | null
  rules_accepted_at: string | null
}

export async function authState(client: SupabaseClient): Promise<AuthState> {
  const session = await peekSession(client)
  if (!session) return { state: 'signed_out' }
  let p: Profile
  try {
    p = await rpc<Profile>(client, 'my_profile')
  } catch (e) {
    if (e instanceof CoffeeError && e.code === 'no_profile') return { state: 'needs_nickname' }
    throw e
  }
  if (p.banned_at) return { state: 'banned', nickname: p.nickname, ban_reason: p.ban_reason ?? null }
  if (!p.rules_accepted_at) return { state: 'needs_rules', nickname: p.nickname }
  return { state: 'ready', nickname: p.nickname, role: p.role, muted_until: p.muted_until ?? null }
}

export function createHelperClient(url: string, key: string): SupabaseClient {
  const mem = new Map<string, string>() // holds the PKCE verifier; auth.json is the only durable copy
  const client = createClient(url, key, {
    auth: {
      flowType: 'pkce',
      autoRefreshToken: false,
      persistSession: true,
      storage: {
        getItem: (k) => mem.get(k) ?? null,
        setItem: (k, v) => void mem.set(k, v),
        removeItem: (k) => void mem.delete(k),
      },
    },
  })
  storages.set(client, mem)
  return client
}
