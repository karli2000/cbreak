// Spike S1 helper stand-in. Prints one JSON line a second on stdout, the way
// coffeebreakd will stream chat. It also listens on 127.0.0.1:<random port>
// and on a Unix socket, so the mod can test talking back to it with
// $.http.fetch (the mod can't write to a spawned process's stdin).
//
// Its own lifecycle goes to ticker.log next to this file: start, an "alive"
// line every 10 ticks (with ppid, to spot orphaning), signals and exit.
// No "exit" line after the last "alive" means it was SIGKILLed.
import { appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG = join(import.meta.dir, 'ticker.log')
const startPpid = process.ppid

function tlog(msg: string) {
  try {
    appendFileSync(
      LOG,
      `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} ${msg}\n`,
    )
  } catch {}
}

function emit(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function echoHandler(nick: string) {
  return async (req: Request) => {
    const body = (await req.text()).slice(0, 280)
    tlog(`${nick} received ${body.length} chars`)
    emit({ type: 'message', nick, body })
    return new Response('ok')
  }
}

const socketPath = join(tmpdir(), `coffee-spike-${process.pid}.sock`)
const tcp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: echoHandler('echo-tcp') })
const unix = Bun.serve({ unix: socketPath, fetch: echoHandler('echo-unix') })

function cleanup() {
  try {
    tcp.stop(true)
    unix.stop(true)
  } catch {}
  try {
    rmSync(socketPath, { force: true })
  } catch {}
}

tlog(`start port=${tcp.port} socket=${socketPath}`)
emit({ type: 'hello', pid: process.pid, port: tcp.port, socket: socketPath })

let n = 0
let orphanLogged = false
setInterval(() => {
  n += 1
  emit({ type: 'message', nick: ['lena', 'yuki', 'ravi', 'max_k', 'bot'][n % 5], body: `tick ${n}` })
  if (n % 10 === 0) tlog(`alive tick ${n}`)
  if (!orphanLogged && process.ppid !== startPpid) {
    orphanLogged = true
    tlog(`ORPHANED: ppid changed ${startPpid} -> ${process.ppid}`)
  }
}, 1000)

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE'] as const) {
  process.on(sig, () => {
    tlog(`got ${sig}`)
    cleanup()
    process.exit(0)
  })
}
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  tlog(`stdout error ${err.code ?? err.message}`)
  cleanup()
  process.exit(1)
})
process.on('exit', code => tlog(`exit code=${code}`))
