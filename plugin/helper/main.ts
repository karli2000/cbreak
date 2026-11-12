// coffeebreakd: the helper process the Claude Code mod talks to over a unix socket.
// stdout = NDJSON events, stdin is unused. Run: bun plugin/helper/main.ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/backend'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { emitAuth, fetchGithubAge, startServer, type Ctx } from './api'
import { AuthStore, createHelperClient, ensureFreshSession, peekSession } from './auth'
import { createEmitter } from './emit'
import { CoffeeError, rpc } from './rpc'

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

const client = createHelperClient(process.env.COFFEEBREAK_SUPABASE_URL ?? SUPABASE_URL, process.env.COFFEEBREAK_SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY)
const store = new AuthStore(dataDir)

let lastRequest = Date.now()
const ctx: Ctx = {
  client,
  store,
  emit,
  room: null,
  touch: () => void (lastRequest = Date.now()),
  marginS,
  signedIn: false,
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig))

const server = startServer(socketPath, ctx)
emit({ type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, socket: socketPath })

/** Refreshes the session if needed; a thrown 'network' means try again next tick. Returns whether a session exists. */
async function refresh(): Promise<boolean> {
  try {
    const s = await ensureFreshSession(client, store, marginS)
    if (!s && ctx.signedIn) emit({ type: 'auth', state: 'signed_out' })
    ctx.signedIn = !!s
    return ctx.signedIn
  } catch (e) {
    if (e instanceof CoffeeError && e.code === 'network') return !!(await peekSession(client))
    throw e
  }
}

async function start() {
  const has = await refresh().catch((e) => {
    emit({ type: 'error', code: 'unknown', message: String(e) })
    return false
  })
  if (!has) {
    emit({ type: 'auth', state: 'signed_out' })
    return
  }
  await emitAuth(ctx)
  try {
    const p = await rpc<{ rules_accepted_at: string | null; github_created_at: string | null; banned_at: string | null }>(client, 'my_profile')
    if (p.rules_accepted_at && !p.banned_at && !p.github_created_at) await fetchGithubAge(client)
  } catch {}
}

const tick = setInterval(() => {
  refresh()
    .then(async (has) => {
      if (has) await ctx.room?.heartbeat()
    })
    .catch((e) => emit({ type: 'error', code: 'unknown', message: String(e) }))
}, tickMs)

const idle = setInterval(() => {
  if (Date.now() - lastRequest >= idleExitMs) void shutdown('idle')
}, Math.max(50, Math.min(1000, idleExitMs / 4)))

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
    if (await peekSession(client)) {
      // RoomSession.leave = leave_room + remove the channel; never throws
      const leaving = ctx.room ? ctx.room.leave() : rpc(client, 'leave_room').catch(() => {})
      await Promise.race([leaving, Bun.sleep(3000)])
    }
  } catch {}
  try {
    await server.stop(true)
  } catch {}
  rmSync(socketPath, { force: true })
  process.exit(0)
}

await start()
