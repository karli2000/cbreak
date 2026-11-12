import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthState, Role } from '../shared/protocol'
import { CoffeeError, rpc } from './rpc'

const LOCK_RETRY_MS = 100
const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

export class AuthStore {
  private file: string
  private lock: string
  constructor(private dataDir: string) {
    this.file = join(dataDir, 'auth.json')
    this.lock = join(dataDir, 'auth.lock')
  }

  private async ensureDir() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    await chmod(this.dataDir, 0o700)
  }

  async read(): Promise<Session | null> {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8'))
      if (j?.version !== 1 || !j.session) return null
      return j.session as Session
    } catch {
      return null
    }
  }

  async write(s: Session): Promise<void> {
    await this.ensureDir()
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify({ version: 1, session: s }), { mode: 0o600 })
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

const nowS = () => Math.floor(Date.now() / 1000)
const fresh = (s: Session | null | undefined, marginS: number): s is Session =>
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
  const current = (await client.auth.getSession()).data.session
  if (fresh(current, marginS)) return current

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
        if (error) {
          await store.clear()
          return null
        }
        await client.realtime.setAuth(onDisk.access_token)
      }
      return onDisk
    }
    const refresh_token = (onDisk ?? current)?.refresh_token
    if (!refresh_token) return null
    const { data, error } = await client.auth.refreshSession({ refresh_token })
    if (error || !data.session) {
      // revoked/invalid token: forget it. Network trouble keeps the file.
      if (error && /network|fetch/i.test(error.message)) throw new CoffeeError('network', error.message)
      await store.clear()
      return null
    }
    await store.write(data.session)
    await client.realtime.setAuth(data.session.access_token)
    return data.session
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
  const { data } = await client.auth.getSession()
  if (!data.session) return { state: 'signed_out' }
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
  return createClient(url, key, {
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
}
