// Plugin tests for the cbreak mod: `claude plugin test plugin` (or `bun run test:mod`).
// The test's own hooks sit beneath the plugin and play the world: the helper process, its socket,
// the panes, the store and the clock.
import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { AgentInfo, HttpInit, On, PaneOpenArgs, ProcessSpawnChunk, ProcessSpawnRequest } from 'claude-code'

const PLUGIN = 'cbreak'
const SECRET = 'SECRET-PROMPT-1234'
const IDLE = '☕ The cbreak room is only open while Claude is working.'
const SOCKET = '/tmp/cbreak-test/1.sock'
const HOME = '/home/tester'
const BUN_LINE = 'cbreak needs Bun. Install it with: curl -fsSL https://bun.sh/install | bash — then restart Claude Code.'

type Fetch = { url: string; init?: HttpInit }

/** A fake cbreakd: each `emit` is one NDJSON line on stdout; `exit` ends the stream. */
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

/**
 * Where Bun is. `path`: what `bun --version` prints (null: the spawn cannot start, 'hang': it never
 * answers). `home`: the same for ~/.bun/bin/bun, null when it does not exist. `src` sets
 * CBREAK_HELPER_SRC=1.
 */
type Version = string | null | 'hang'
type Bun = { path: Version; home: Version; src?: boolean }
const HOME_BUN = `${HOME}/.bun/bin/bun`

/** Answers everything beneath the plugin and records what reaches the outside world. */
function world(on: On, bun: Bun = { path: '1.4.4', home: null }) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, bun.src ? { HOME, CBREAK_HELPER_SRC: '1' } : { HOME })
  const w = {
    clock,
    helper: new FakeHelper(),
    /** Helper spawns (the `bun --version` probe is in `probes`). */
    spawns: [] as ProcessSpawnRequest[],
    probes: [] as ProcessSpawnRequest[],
    exists: [] as string[],
    fetches: [] as Fetch[],
    commands: [] as string[],
    opens: [] as PaneOpenArgs[],
    toasts: [] as string[],
    /** What `$.agent.list()` answers. */
    agents: [] as AgentInfo[],
  }
  on('fs.exists', async (_$, e) => {
    w.exists.push(e.path)
    return { value: bun.home !== null && e.path === HOME_BUN }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 'test' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: w.agents }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('command.register', async (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    w.opens.push(e)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.scroll', async () => ({}))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* (_$, e) {
    if (e.argv[1] === '--version') {
      w.probes.push(e)
      const v = e.argv[0] === HOME_BUN ? bun.home : bun.path
      if (v === null) throw new Error(`spawn ${e.argv[0]} ENOENT`)
      if (v === 'hang') await new Promise<never>(() => {}) // a shim that never answers
      yield { stream: 'stdout', text: `${v}\n` }
      return { value: { code: 0, signal: null } }
    }
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

const runCbreak = ($: Engine, args = '') =>
  $.command.run({ command: 'cbreak', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const startSession = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

/** A helper that says hello, is signed in and joins the lobby. */
function helperJoins(w: ReturnType<typeof world>): void {
  w.helper.emit({ type: 'hello', protocol: 1, pid: 4242, socket: SOCKET })
  w.helper.emit({ type: 'auth', state: 'ready', nickname: 'max_k', role: 'user', muted_until: null })
  w.helper.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 2 })
}

test('registers /cbreak', async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.commands).toContain('cbreak')
})

test('cbreak while idle answers the idle rule', async ($, on) => {
  world(on)
  await startSession($)
  const res = await runCbreak($)
  expect(res.text).toBe(IDLE)
})

test('cbreak while busy opens the pane focused before it answers', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(5_000)
  await runCbreak($)
  // opened inside the command (an asked open, placed at any width), before the helper joined
  expect(w.opens).toEqual([{ id: 'cbreak', title: '☕ lobby · 0 here', focus: true }])
  expect(w.fetches).toHaveLength(0)
})

test('the break goes on while background subagents work, and ends when they are done', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  w.agents = [{ id: 'agent-1', description: 'review', type: 'general-purpose', status: 'running' }]
  await $.turn.complete({ turnId: 't1', isAborted: false, answer: '', durationMs: 25_000, reason: 'answer' })
  await w.clock.settle()
  const mount = () =>
    $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: 'cbreak',
      props: { title: '☕ lobby · 2 here', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
  let ui = await mount()
  expect(await ui.find({ type: 'Text', text: "Claude's subagents are still working ☕" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'closes in 15 s' })).toBeUndefined()
  await ui.unmount()
  w.agents = [{ id: 'agent-1', description: 'review', type: 'general-purpose', status: 'completed' }]
  await $.turn.complete({ turnId: 't-sub', agentId: 'agent-1', isAborted: false, answer: '', durationMs: 1000, reason: 'answer' })
  await w.clock.settle()
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: 'closes in 15 s' })).toBeDefined()
  await ui.unmount()
})

test('subagent turns are ignored', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'sub task', turnId: 't-sub', agentId: 'agent-1' })
  await w.clock.advance(20_000)
  expect(w.spawns).toHaveLength(0)
})

test('prompt text never reaches spawn or fetch', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.prompt.submit({ text: SECRET, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: SECRET, turnId: 't1' })
  await w.clock.advance(20_000)
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
  await w.clock.advance(20_000)
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
    requestId: 'cbreak',
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
  expect(input?.props.autoFocus).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'closes in 15 s' })).toBeUndefined()
  await ui.unmount()
})

test('after the turn the pane shows the countdown beside the input', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  await $.turn.complete({ turnId: 't1', isAborted: false, answer: '', durationMs: 25_000, reason: 'answer' })
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cbreak',
    props: {
      title: '☕ lobby · 2 here',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  const countdown = await ui.find({ type: 'Text', text: 'closes in 15 s' })
  expect(countdown?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'say' })).toBeDefined()
  await ui.unmount()
})

test('a sent message carries emoji', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cbreak',
    props: {
      title: '☕ lobby · 2 here',
      isFocused: true,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  await $.ui.input({ plugin: PLUGIN, key: 'say', text: 'hey :heart:' })
  await w.clock.settle()
  const send = w.fetches.find((f) => new URL(f.url).pathname === '/send')
  expect(JSON.parse(String(send?.init?.body))).toEqual({ body: 'hey ❤️' })
  await ui.unmount()
})

test('typing :token shows the emoji box above the input; a pressed row fills the input', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cbreak',
    props: {
      title: '☕ lobby · 2 here',
      isFocused: true,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Button', key: 'emoji:smile' })).toBeUndefined()
  await ui.input({ key: 'say', text: 'hi :smi', kind: 'change' })
  await w.clock.settle()
  // best match first, drawn AFTER the input: the focus ring follows positions, so rows drawn before
  // the input would take the ring off it while typing (spike S4, 0.3.6)
  const keyed = (await ui.findAll({})).flatMap((el) => (typeof el.props.key === 'string' ? [el.props.key] : []))
  expect(keyed).toEqual(['say', 'emoji:smile', 'emoji:smirk', 'emoji:smiley', 'emoji:smile_cat', 'emoji:smirk_cat'])
  const rows = await ui.findAll({ type: 'Button' })
  expect(rows[0]?.props).toMatchObject({ label: '😄  :smile:', plain: true, dimColor: true })
  await ui.press({ key: 'emoji:smirk' })
  await w.clock.settle()
  expect((await ui.find({ type: 'Input', key: 'say' }))?.props.value).toBe('hi 😏 ')
  expect(await ui.find({ type: 'Button', key: 'emoji:smile' })).toBeUndefined()
  // the press also hands the focus back to the input ($.ui.focus): the kit answers no plugin-raised
  // ui.focus, so that part was checked in a real terminal (spikes/FINDINGS.md S4)
  await ui.input({ key: 'say', text: 'hi 😏 yo' })
  await w.clock.settle()
  const send = w.fetches.find((f) => new URL(f.url).pathname === '/send')
  expect(JSON.parse(String(send?.init?.body))).toEqual({ body: 'hi 😏 yo' })
  await ui.unmount()
})

test('the helper runs from the committed bundle with bun on PATH', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  expect(w.probes.map((p) => p.argv)).toEqual([['bun', '--version']])
  expect(w.spawns).toHaveLength(1)
  const argv = w.spawns[0]!.argv
  expect(argv).toHaveLength(2)
  expect(argv[0]).toBe('bun')
  expect(argv[1]).toEndWith('/dist/cbreakd.js')
})

test('finds bun in ~/.bun/bin when PATH has none', async ($, on) => {
  const w = world(on, { path: null, home: '1.4.4' })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  expect(w.exists).toEqual([`${HOME}/.bun/bin/bun`])
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.argv[0]).toBe(`${HOME}/.bun/bin/bun`)
  expect(w.spawns[0]!.argv[1]).toEndWith('/dist/cbreakd.js')
})

test('an old bun on PATH does not count', async ($, on) => {
  const w = world(on, { path: '1.1.38', home: '1.4.4' })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  expect(w.spawns[0]?.argv[0]).toBe(`${HOME}/.bun/bin/bun`)
})

test('without bun nothing is spawned and the break start shows the Bun line', async ($, on) => {
  const w = world(on, { path: null, home: null })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(0)
  expect(w.toasts).toEqual([BUN_LINE])
  expect((await runCbreak($)).text).toBe(BUN_LINE)
  expect((await runCbreak($, 'setup')).text).toBe(BUN_LINE)
  expect(w.probes).toHaveLength(1) // looked up once per session
})

test('CBREAK_HELPER_SRC=1 runs the helper source', async ($, on) => {
  const w = world(on, { path: '1.4.4', home: null, src: true })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  expect(w.probes).toHaveLength(0)
  expect(w.spawns[0]?.argv[0]).toBe('bun')
  expect(w.spawns[0]?.argv[1]).toEndWith('/helper/main.ts')
})

test('a bun --version that never answers times out and falls through to ~/.bun/bin/bun', async ($, on) => {
  const w = world(on, { path: 'hang', home: '1.4.4' })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(15_000)
  expect(w.spawns).toHaveLength(0)
  await w.clock.advance(3_000)
  await w.clock.settle()
  expect(w.probes.map((p) => p.argv[0])).toEqual(['bun', HOME_BUN])
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.argv[0]).toBe(HOME_BUN)
})

test('a hanging bun --version and no home bun give the Bun line', async ($, on) => {
  const w = world(on, { path: 'hang', home: null })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(23_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(0)
  expect(w.toasts).toEqual([BUN_LINE])
})

test('an old bun in ~/.bun/bin gives the Bun line', async ($, on) => {
  const w = world(on, { path: null, home: '1.1.38' })
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(0)
  expect(w.toasts).toEqual([BUN_LINE])
})

/** The pane as the surface would draw it: docked beside the transcript or inline above the prompt. */
const mountPane = ($: Engine, placement: 'dock' | 'inline', bodyRows = 30) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cbreak',
    props: { title: '☕ lobby · 2 here', isFocused: true, bodyColumns: 60, placement, scroll: { offset: 0, bodyRows }, view: {} },
  })

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const kids = (el: unknown) => ((el as Drawn).children ?? []) as Drawn[]
const holdsInput = (el: Drawn, key: string): boolean =>
  (el.type === 'Input' && el.props?.key === key) || kids(el).some((c) => holdsInput(c, key))

test('docked, the chat input sits at the bottom of the pane however few lines there are', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  const ui = await mountPane($, 'dock', 30)
  const root = (await ui.drawn()) as Drawn
  // The tree fills the body: the lines' box takes the free rows, so the input row is the last row.
  expect(root.props).toMatchObject({ flexDirection: 'column', minHeight: 30 })
  const parts = kids(root)
  expect(parts).toHaveLength(3) // header, lines, input row
  expect(parts[1]!.props).toMatchObject({ flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end' })
  expect(holdsInput(parts[2]!, 'say')).toBe(true)
  expect(holdsInput(parts[1]!, 'say')).toBe(false)
  await ui.unmount()
})

test('inline, the pane stays as tall as its lines', async ($, on) => {
  const w = world(on)
  await startSession($)
  await $.turn.start({ text: 'long task', turnId: 't1' })
  await w.clock.advance(20_000)
  helperJoins(w)
  await w.clock.settle()
  const ui = await mountPane($, 'inline', 30)
  const root = (await ui.drawn()) as Drawn
  expect(root.props?.minHeight).toBeUndefined()
  expect(holdsInput(kids(root).at(-1)!, 'say')).toBe(true)
  await ui.unmount()
})

test('docked, the setup input sits at the bottom of the pane too', async ($, on) => {
  const w = world(on)
  await startSession($)
  w.helper.emit({ type: 'hello', protocol: 1, pid: 4242, socket: SOCKET })
  w.helper.emit({ type: 'auth', state: 'signed_out' })
  await runCbreak($, 'setup')
  await w.clock.settle()
  const ui = await mountPane($, 'dock', 24)
  const root = (await ui.drawn()) as Drawn
  expect(root.props).toMatchObject({ flexDirection: 'column', minHeight: 24 })
  const parts = kids(root)
  expect(parts).toHaveLength(2) // lines, input
  expect(parts[0]!.props).toMatchObject({ flexGrow: 1, justifyContent: 'flex-end' })
  expect(holdsInput(parts[1]!, 'setup')).toBe(true)
  await ui.unmount()
})
