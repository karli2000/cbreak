// Plugin tests for the Coffee Break mod: `claude plugin test plugin` (or `bun run test:mod`).
// The test's own hooks sit beneath the plugin and play the world: the helper process, its socket,
// the panes, the store and the clock.
import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpInit, On, ProcessSpawnChunk, ProcessSpawnRequest } from 'claude-code'

const PLUGIN = 'coffeebreak'
const SECRET = 'SECRET-PROMPT-1234'
const IDLE = '☕ The coffee room is only open while Claude is working.'
const SOCKET = '/tmp/coffeebreak-test/1.sock'

type Fetch = { url: string; init?: HttpInit }

/** A fake coffeebreakd: each `emit` is one NDJSON line on stdout; `exit` ends the stream. */
class FakeHelper {
  private queue: ProcessSpawnChunk[] = []
  private wake: (() => void) | null = null
  private ended = false

  emit(event: Record<string, unknown>): void {
    this.queue.push({ stream: 'stdout', text: JSON.stringify(event) + '\n' })
    this.wake?.()
  }

  exit(): void {
    this.ended = true
    this.wake?.()
  }

  async *stream(): AsyncGenerator<ProcessSpawnChunk, { code: number | null; signal: string | null }> {
    while (true) {
      const chunk = this.queue.shift()
      if (chunk) {
        yield chunk
        continue
      }
      if (this.ended) return { code: 0, signal: null }
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

/** Answers everything beneath the plugin and records what reaches the outside world. */
function world(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  const w = {
    clock,
    helper: new FakeHelper(),
    spawns: [] as ProcessSpawnRequest[],
    fetches: [] as Fetch[],
    commands: [] as string[],
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'test' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('command.register', async (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.scroll', async () => ({}))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('process.spawn', async function* (_$, e) {
    w.spawns.push(e)
    return { value: yield* w.helper.stream() }
  })
  on('http.fetch', async (_$, e) => {
    w.fetches.push(e)
    const path = new URL(e.url).pathname
    const data = path === '/join' ? { room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 2 } : {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, data }) } }
  })
  return w
}

const startSession = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

/** A helper that says hello, is signed in and joins the lobby. */
function helperJoins(w: ReturnType<typeof world>): void {
  w.helper.emit({ type: 'hello', protocol: 1, pid: 4242, socket: SOCKET })
  w.helper.emit({ type: 'auth', state: 'ready', nickname: 'max_k', role: 'user', muted_until: null })
  w.helper.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 2 })
}

test('registers /coffee', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.commands).toContain('coffee')
})

test('coffee while idle answers the idle rule', async ($, on) => {
  world(on)
  await startSession($)
  const res = await $.command.run({
    command: 'coffee',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(res.text).toBe(IDLE)
})

test('subagent turns are ignored', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'sub task', turnId: 't-sub', agentId: 'agent-1' })
  await w.clock.advance(25_000)
  expect(w.spawns).toHaveLength(0)
})

test('prompt text never reaches spawn or fetch', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.prompt.submit({ text: SECRET, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: SECRET, turnId: 't1' })
  await w.clock.advance(25_000)
  expect(w.spawns).toHaveLength(1)
  helperJoins(w)
  await w.clock.settle()
  await w.clock.advance(25_000) // a /ping too
  expect(w.fetches.map((f) => new URL(f.url).pathname)).toContain('/join')
  for (const s of w.spawns) expect(JSON.stringify(s)).not.toContain(SECRET)
  for (const f of w.fetches) expect(JSON.stringify(f)).not.toContain(SECRET)
})

test('pane draws messages and the input', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(25_000)
  helperJoins(w)
  await w.clock.settle()
  w.helper.emit({
    type: 'message',
    id: 7,
    user_id: 'u-lena',
    nickname: 'lena',
    body: 'hi @max_k',
    created_at: '2026-11-12T10:00:00Z',
    role: 'user',
  })
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'coffee',
    props: {
      title: '☕ lobby · 2 here',
      isFocused: true,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: 'lena' })).toBeDefined()
  const mention = (await ui.findAll({ type: 'Text', text: '@max_k' })).at(-1)
  expect(mention?.props).toMatchObject({ bold: true, inverse: true })
  const input = await ui.find({ type: 'Input', key: 'say' })
  expect(input?.props.placeholder).toBe('say something')
  await ui.unmount()
})
