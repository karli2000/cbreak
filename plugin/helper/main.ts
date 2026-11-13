// coffeebreakd: the helper process the Claude Code mod talks to over a unix socket.
// stdout = NDJSON events, stdin is unused. Run: bun plugin/helper/main.ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/backend'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { emitAuth, fetchGithubAgeIfNeeded, startServer, type Ctx } from './api'
import { AuthStore, createHelperClient, ensureFreshSession, peekSession, persistRefreshes, usableWithoutRefresh } from './auth'
import { createEmitter } from './emit'
import { IdleWatch } from './idle'
import { CoffeeError, codeOf, rpc } from './rpc'

const num = (name: string, dflt: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const tickMs = num('COFFEEBREAK_TICK_MS', 30_000)
const idleExitMs = num('COFFEEBREAK_IDLE_EXIT_MS', 60_000)
const marginS = num('COFFEEBREAK_REFRESH_MARGIN_S', 120)
const dataDir =
  process.env.COFFEEBREAK_DATA_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'coffeebreak')

const sockDir = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `coffeebreak-${process.getuid?.() ?? 0}`)
mkdirSync(sockDir, { recursive: true, mode: 0o700 })
chmodSync(sockDir, 0o700)
const socketPath = join(sockDir, `${process.pid}.sock`)

let shuttingDown = false
let shutdown: (reason: string) => Promise<void> = async () => {}

const emit = createEmitter(
  (s) => process.stdout.write(s),
  () => void shutdown('stdout_closed'),
)
// a closed stdout surfaces asynchronously as an 'error' event on the stream
process.stdout.on('error', () => void shutdown('stdout_closed'))

const backendUrl = process.env.COFFEEBREAK_SUPABASE_URL ?? SUPABASE_URL
const client = createHelperClient(backendUrl, process.env.COFFEEBREAK_SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY)
// the login file is per backend (auth.json for the hosted project), so a dev run never touches the real login
const store = new AuthStore(dataDir, backendUrl)
// any refresh supabase-js does on its own (e.g. Realtime asking for a token) still reaches the file
persistRefreshes(client, store)

const idleIntervalMs = Math.max(50, Math.min(1000, idleExitMs / 4))
const idleWatch = new IdleWatch({ idleExitMs, intervalMs: idleIntervalMs })
const sessionId = crypto.randomUUID()
const ctx: Ctx = {
  client,
  store,
  emit,
  room: null,
  touch: () => idleWatch.touch(),
  marginS,
  signedIn: false,
  sessionId,
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig))

const server = startServer(socketPath, ctx)
emit({ type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, socket: socketPath })

/** Refreshes the session if needed; a thrown 'network' means try again next tick. Returns whether a session exists. */
async function refresh(): Promise<boolean> {
  try {
    const s = await ensureFreshSession(client, store, marginS)
    if (!s && ctx.signedIn) emit({ type: 'auth', state: 'signed_out' })
    if (!s && ctx.room) {
      // signed out under us: forget the room locally (no session left for leave_room)
      ctx.room.drop()
      ctx.room = null
    }
    ctx.signedIn = !!s
    return ctx.signedIn
  } catch (e) {
    if (e instanceof CoffeeError && e.code === 'network') return !!(await peekSession(client))
    throw e
  }
}

/** Error event for a failed tick or start; the same code is not repeated until a tick succeeds. */
let tickError: string | null = null
function emitTickError(e: unknown) {
  const code = codeOf(e)
  if (code === tickError) return
  tickError = code
  emit({ type: 'error', code, ...(e instanceof Error && e.message !== code ? { message: e.message } : {}) })
}

async function start() {
  const has = await refresh().catch((e) => {
    emitTickError(e)
    return false
  })
  if (!has) {
    emit({ type: 'auth', state: 'signed_out' })
    return
  }
  await emitAuth(ctx)
  await fetchGithubAgeIfNeeded(client)
}

const tick = setInterval(() => {
  refresh()
    .then(async (has) => {
      tickError = null
      if (has) await ctx.room?.heartbeat()
    })
    .catch(emitTickError)
}, tickMs)

// suspend-aware: after laptop sleep the first check resets the idle time instead of exiting
const idle = setInterval(() => {
  if (idleWatch.check()) void shutdown('idle')
}, idleIntervalMs)

const parentPid = process.ppid
const orphan = setInterval(() => {
  if (process.ppid !== parentPid) void shutdown('orphaned')
}, 1000)

shutdown = async (_reason: string) => {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(tick)
  clearInterval(idle)
  clearInterval(orphan)
  try {
    const session = await peekSession(client)
    if (session && usableWithoutRefresh(session)) {
      // RoomSession.leave = leave_room + remove the channel; never throws
      const leaving = ctx.room ? ctx.room.leave() : rpc(client, 'leave_room', { session_id: sessionId }).catch(() => {})
      await Promise.race([leaving, Bun.sleep(3000)])
    } else {
      // a token close to expiry would make supabase-js refresh outside the lock, and an exit in the
      // middle would leave a spent refresh token in the file: skip leave_room (the row goes stale in 90 s)
      ctx.room?.drop()
    }
  } catch {}
  try {
    await server.stop(true)
  } catch {}
  rmSync(socketPath, { force: true })
  process.exit(0)
}

await start()
