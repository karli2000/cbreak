// The Coffee Break mod: Claude Code hooks wired to one Controller. The Port below is the
// Controller's only way out; it acts on the latest `$` an event hook received. Spike rules: `$` is
// only passed into top-level functions, and the render hook writes nothing while drawing.
//
// Privacy: the turn and prompt hooks read only `agentId` and `isAborted`. Prompt text never
// reaches the Controller, the helper process or the socket.
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'
import type { Api, ApiPath, ApiResult, HelperEvent } from '../shared/protocol.ts'
import { Controller } from './lib/controller.ts'
import { splitLines } from './lib/format.ts'
import { bunVersionOk, helperArgv, homeBunPath } from './lib/helper-argv.ts'
import type { Port, Timer } from './lib/port.ts'
import { mergeStored, type Settings } from './lib/settings.ts'
import { renderPane } from './pane.ts'

type Engine = EngineInterface
type ExitInfo = { code: number | null; signal: string | null; stderr: string }
type Child = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; stopping: boolean }

const PANE = 'coffee'
const STDERR_KEEP = 2000
const CLOSE_TIMEOUT_MS = 3000
const TOAST_MS = 8000

let controller: Controller | null = null
/** The Port over the newest `$` an event hook received (validation forbids keeping `$` itself). */
let current: Port | null = null
/** While `/coffee` runs, its own `$`: an open made through it answers the person's command. */
let pinned: Port | null = null
let child: Child | null = null
/** A helper start waiting on the Bun lookup; `stopHelper` cancels it so no orphan is spawned. */
let starting: { cancelled: boolean } | null = null
/** The helper's argv, looked up once per module load (session): null when there is no Bun. */
let argvLookup: Promise<string[] | null> | null = null
/** The pane is open (placed or waiting) under this title; null when closed. */
let paneTitle: string | null = null

/** Every event hook goes through here: it moves the Port to this `$` and builds the Controller once. */
function ctl($: Engine): Controller {
  current = portOver($)
  controller ??= new Controller(forwarder())
  return controller
}

function now(): Port {
  const p = pinned ?? current
  if (!p) throw new Error('coffeebreak: no engine yet')
  return p
}

/** The Controller's one Port: every call goes to the Port over the newest `$`. */
function forwarder(): Port {
  return {
    spawnHelper: (onEvent, onExit) => now().spawnHelper(onEvent, onExit),
    stopHelper: () => now().stopHelper(),
    call: (socket, path, body) => now().call(socket, path, body),
    openPane: (focus, title) => now().openPane(focus, title),
    closePane: () => now().closePane(),
    redraw: () => now().redraw(),
    scrollToEnd: () => now().scrollToEnd(),
    status: (text) => now().status(text),
    toast: (text) => now().toast(text),
    after: (ms, fn) => now().after(ms, fn),
    loadSettings: () => now().loadSettings(),
    saveSettings: (s) => now().saveSettings(s),
  }
}

function portOver($: Engine): Port {
  return {
    spawnHelper: (onEvent, onExit) => spawnHelper($, onEvent, onExit),
    stopHelper: () => stopHelper(),
    call: (socket, path, body) => callHelper($, socket, path, body),
    openPane: (focus, title) => openPane($, focus, title),
    closePane: () => closePane($),
    redraw: () => redraw($),
    scrollToEnd: () => scrollToEnd($),
    status: (text) => $.ui.status(text),
    toast: (text) => $.ui.toast(text, { timeoutMs: TOAST_MS }),
    after: (ms, fn) => $.clock.after(ms, fn),
    loadSettings: () => loadSettings($),
    saveSettings: (s) => saveSettings($, s),
  }
}

// ---------- helper process ----------

/**
 * Starts coffeebreakd with the argv the Bun lookup found. Without Bun nothing is spawned: the
 * Controller gets `error no_bun` and an exit (ruling R2).
 */
function spawnHelper($: Engine, onEvent: (e: HelperEvent) => void, onExit: (info: ExitInfo) => void): void {
  const start = { cancelled: false }
  starting = start
  argvLookup ??= findHelperArgv($).catch(() => null)
  void argvLookup.then((argv) => {
    if (starting === start) starting = null
    if (start.cancelled) return onExit({ code: null, signal: null, stderr: '' })
    if (!argv) {
      onEvent({ type: 'error', code: 'no_bun' })
      return onExit({ code: null, signal: null, stderr: 'no_bun' })
    }
    let stream: Child['stream']
    try {
      stream = $.process.spawn({ argv })
    } catch {
      return onExit({ code: null, signal: null, stderr: '' })
    }
    const c: Child = { stream, stopping: false }
    child = c
    void pump(c, onEvent, onExit, (text) => $.ui.log(text, { to: 'debug' }))
  })
}

/** `COFFEEBREAK_HELPER_SRC=1` → the source; else the bundle via `bun` on PATH (≥ 1.2), else ~/.bun/bin/bun. */
async function findHelperArgv($: Engine): Promise<string[] | null> {
  const fromSource = (await $.env.get('COFFEEBREAK_HELPER_SRC').catch(() => undefined)) === '1'
  const pathBun = !fromSource && (await bunOnPath($))
  const homeBun = fromSource || pathBun ? null : await bunInHome($)
  return helperArgv($.plugin.root, { pathBun, homeBun, fromSource })
}

/** A one-off `bun --version`: true when it exits 0 with a version of at least 1.2. */
async function bunOnPath($: Engine): Promise<boolean> {
  try {
    const probe = $.process.spawn({ argv: ['bun', '--version'] })
    let out = ''
    for await (const chunk of probe) if (chunk.stream === 'stdout') out += chunk.text
    const res = await probe.result
    return res.code === 0 && bunVersionOk(out)
  } catch {
    return false // not on PATH (the spawn cannot start) or refused
  }
}

async function bunInHome($: Engine): Promise<string | null> {
  try {
    const path = homeBunPath(await $.env.get('HOME'))
    return path && (await $.fs.exists(path)) ? path : null
  } catch {
    return null
  }
}

/** Reads the helper's NDJSON stdout until it ends. Leaving the loop (or `return()`) kills the child. */
async function pump(
  c: Child,
  onEvent: (e: HelperEvent) => void,
  onExit: (info: ExitInfo) => void,
  log: (text: string) => void,
): Promise<void> {
  let rest = ''
  let stderr = ''
  let result: ProcessSpawnResult = { code: null, signal: null }
  try {
    for await (const chunk of c.stream) {
      if (c.stopping) break
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-STDERR_KEEP)
        continue
      }
      const split = splitLines(rest, chunk.text)
      rest = split.rest
      for (const line of split.lines) {
        const e = parseEvent(line)
        if (!e) continue
        try {
          onEvent(e) // a Controller fault must not end the loop, which would kill the helper
        } catch (err) {
          log(`coffeebreak: ${e.type} event failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    if (!c.stopping) result = await c.stream.result
  } catch {
    // could not start, or killed: reported as an exit below
  } finally {
    if (child === c) child = null
    onExit({ ...result, stderr })
  }
}

function parseEvent(line: string): HelperEvent | null {
  try {
    const v: unknown = JSON.parse(line)
    return v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string' ? (v as HelperEvent) : null
  } catch {
    return null
  }
}

function stopHelper(): void {
  if (starting) {
    starting.cancelled = true
    starting = null
  }
  const c = child
  if (!c) return
  c.stopping = true
  child = null
  // return() kills the child; it settles once the pending read does, so it is not awaited.
  c.stream.return({ code: null, signal: null }).catch(() => {})
}

async function callHelper<P extends ApiPath>(
  $: Engine,
  socket: string,
  path: P,
  body: Api[P]['req'],
): Promise<ApiResult<P>> {
  const res = await $.http.fetch('http://localhost' + path, {
    method: 'POST',
    socketPath: socket,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  try {
    const v = JSON.parse(res.text) as ApiResult<P>
    if (v && typeof v === 'object' && typeof v.ok === 'boolean') return v
  } catch {}
  return { ok: false, code: 'network' }
}

// ---------- pane ----------

async function openPane($: Engine, focus: boolean, title: string): Promise<{ placed: boolean }> {
  paneTitle = title
  const res = await $.ui.open({ id: PANE, title, ...(focus ? { focus: true as const } : {}) })
  return { placed: res.isPlaced }
}

/** False when the close was refused (after Esc a close is refused until the next input) or threw. */
async function closePane($: Engine): Promise<boolean> {
  let timer: Timer | null = null
  const timedOut = new Promise<false>((r) => (timer = $.clock.after(CLOSE_TIMEOUT_MS, () => r(false))))
  const closed = (async () => {
    await $.ui.close({ id: PANE })
    const panes = await $.ui.panes()
    return !panes.some((p) => p.id === PANE)
  })().catch(() => false)
  const ok = await Promise.race([closed, timedOut])
  ;(timer as Timer | null)?.cancel()
  if (ok) paneTitle = null
  return ok
}

/** Redraws the pane, and retitles it when the header (room · N here) changed while it is open. */
function redraw($: Engine): void {
  $.ui.invalidate('ui.render')
  const view = controller?.view()
  if (paneTitle === null || view?.mode !== 'chat' || view.header === paneTitle) return
  paneTitle = view.header
  $.ui.open({ id: PANE, title: view.header }).catch(() => {})
}

function scrollToEnd($: Engine): void {
  $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {})
}

// ---------- store ----------

async function loadSettings($: Engine): Promise<Settings> {
  return mergeStored(await $.store.get('settings'))
}

async function saveSettings($: Engine, s: Settings): Promise<void> {
  await $.store.set('settings', s)
}

// ---------- hooks ----------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    ctl($)
    await $.command.register({
      name: 'coffee',
      description: 'Chat with other people in the coffee room while Claude works',
      argumentHint: '[setup|status|name|room|config|on|off|logout|delete-account]',
      immediate: true,
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ctl($).sessionEnd()
    return next(e)
  })

  // Gating hooks: a failure of ours must never hold up a prompt or a close.
  on('prompt.submit', async ($, e, next) => {
    ctl($).promptSubmitted()
    return next(e)
  }).catch(async (_$, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) ctl($).turnStart()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) ctl($).turnComplete(e.isAborted)
    return next(e)
  })

  // The Controller opens the pane before `command()` resolves; pinning this hook's `$` makes that
  // open answer the person's command, so it is placed at any width (unasked needs 144 columns).
  on('command.run', { command: 'coffee' }, async ($, e) => {
    const c = ctl($)
    const p = portOver($)
    pinned = p
    try {
      return { text: await c.command(e.args) }
    } finally {
      if (pinned === p) pinned = null
    }
  })

  // Our own closes (origin `plugin`) are settled by closePane, which checks the pane is really gone
  // (after Esc a close is refused); here only the person's close is handled.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const res = await next(e)
    if (e.origin.kind === 'person') {
      paneTitle = null
      ctl($).paneClosedByPerson()
    }
    return res
  }).catch(async (_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const c = controller
    if (!c) return Text({ dimColor: true, children: '☕' })
    return renderPane(c.view(), { Box, Text, Input }, {
      input: (v) => c.input(v),
      submit: (v) => void c.submit(v),
    })
  })
}
