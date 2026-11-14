// The cbreak mod: Claude Code hooks wired to one Controller. The Port below is the
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
import { renderPane, SAY_KEY } from './pane.ts'

type Engine = EngineInterface
type ExitInfo = { code: number | null; signal: string | null; stderr: string }
type Child = { stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>; stopping: boolean }

const PANE = 'cbreak'
const STDERR_KEEP = 2000
const CLOSE_TIMEOUT_MS = 3000
const TOAST_MS = 8000
/** A `bun --version` that has not answered by then counts as no Bun there (a shim may prompt or hang). */
const PROBE_TIMEOUT_MS = 3000

let controller: Controller | null = null
/** The Port over the newest `$` an event hook received (validation forbids keeping `$` itself). */
let current: Port | null = null
/** While `/cbreak` runs, its own `$`: an open made through it answers the person's command. */
let pinned: Port | null = null
let child: Child | null = null
/** A helper start waiting on the Bun lookup; `stopHelper` cancels it so no orphan is spawned. */
let starting: { cancelled: boolean } | null = null
/** The helper's argv, looked up once per module load (session): null when there is no Bun. */
let argvLookup: Promise<string[] | null> | null = null
/** The pane is open (placed or waiting) under this title; null when closed. */
let paneTitle: string | null = null
/** The background the open pane was opened with (every `ui.open` sets it anew, so a retitle must repeat it). */
let paneBg: string | null = null

/** The person's pane background as `ui.open` takes it: painted under the whole body; none = Claude Code's look. */
function bgOpt(): { backgroundColor?: string } {
  const bg = controller?.view().colors.bg ?? null
  paneBg = bg
  return bg ? { backgroundColor: bg } : {}
}

/** Every event hook goes through here: it moves the Port to this `$` and builds the Controller once. */
function ctl($: Engine): Controller {
  current = portOver($)
  controller ??= new Controller(forwarder())
  return controller
}

function now(): Port {
  const p = pinned ?? current
  if (!p) throw new Error('cbreak: no engine yet')
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
    agentsBusy: () => now().agentsBusy(),
    loadSettings: () => now().loadSettings(),
    saveSettings: (s) => now().saveSettings(s),
  }
}

/** Agent statuses that mean work is still going on (a teammate waiting for a message is idle). */
const WORKING = new Set(['pending', 'running', 'waiting'])

/** Whether any subagent or teammate of the session is still working; a failed list counts as none. */
async function agentsBusy($: Engine): Promise<boolean> {
  try {
    return (await $.agent.list()).some((a) => WORKING.has(a.status))
  } catch {
    return false
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
    agentsBusy: () => agentsBusy($),
    loadSettings: () => loadSettings($),
    saveSettings: (s) => saveSettings($, s),
  }
}

// ---------- helper process ----------

/**
 * Starts cbreakd with the argv the Bun lookup found. Without Bun nothing is spawned: the
 * Controller gets `error no_bun` and an exit (ruling R2).
 */
function spawnHelper($: Engine, onEvent: (e: HelperEvent) => void, onExit: (info: ExitInfo) => void): void {
  const start = { cancelled: false }
  starting = start
  argvLookup ??= findHelperArgv($).catch((err: unknown) => {
    $.ui.log(`cbreak: bun lookup failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return null
  })
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

/**
 * `CBREAK_HELPER_SRC=1` → the source; else the bundle via `bun` on PATH, else via ~/.bun/bin/bun
 * (each must answer `--version` with ≥ 1.2 within PROBE_TIMEOUT_MS).
 */
async function findHelperArgv($: Engine): Promise<string[] | null> {
  const fromSource = (await $.env.get('CBREAK_HELPER_SRC')) === '1'
  const pathBun = !fromSource && (await bunVersionAt($, 'bun'))
  const homeBun = fromSource || pathBun ? null : await bunInHome($)
  return helperArgv($.plugin.root, { pathBun, homeBun, fromSource })
}

/**
 * A one-off `<bin> --version`: true when it exits 0 with a version of at least 1.2. A spawn that
 * cannot start is false; one that does not answer within PROBE_TIMEOUT_MS is killed and false.
 */
async function bunVersionAt($: Engine, bin: string): Promise<boolean> {
  let probe: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  try {
    probe = $.process.spawn({ argv: [bin, '--version'] })
  } catch {
    return false
  }
  let timedOut = false
  let timer: Timer | null = null
  const timeout = new Promise<false>((r) => {
    timer = $.clock.after(PROBE_TIMEOUT_MS, () => {
      timedOut = true
      r(false)
    })
  })
  const ran = (async () => {
    let out = ''
    for await (const chunk of probe) if (chunk.stream === 'stdout') out += chunk.text
    const res = await probe.result
    return res.code === 0 && bunVersionOk(out)
  })().catch(() => false) // not there (the first pull rejects) or refused
  const ok = await Promise.race([ran, timeout])
  ;(timer as Timer | null)?.cancel()
  // return() kills the child; it settles once the pending read does, so it is not awaited
  if (timedOut) probe.return({ code: null, signal: null }).catch(() => {})
  return ok
}

async function bunInHome($: Engine): Promise<string | null> {
  const path = homeBunPath(await $.env.get('HOME'))
  return path && (await $.fs.exists(path)) && (await bunVersionAt($, path)) ? path : null
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
          log(`cbreak: ${e.type} event failed: ${err instanceof Error ? err.message : String(err)}`)
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
  const res = await $.ui.open({ id: PANE, title, ...bgOpt(), ...(focus ? { focus: true as const } : {}) })
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

/**
 * Redraws the pane, and re-opens it (no focus) when the header (room · N here) or the background
 * changed while it is open: the title and the painted background are both set by `ui.open`.
 */
function redraw($: Engine): void {
  $.ui.invalidate('ui.render')
  const view = controller?.view()
  if (paneTitle === null || !view) return
  const title = view.mode === 'chat' ? view.header : paneTitle
  if (title === paneTitle && view.colors.bg === paneBg) return
  paneTitle = title
  $.ui.open({ id: PANE, title, ...bgOpt() }).catch(() => {})
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
      name: 'cbreak',
      description: 'Chat with other people in the cbreak room while Claude works',
      argumentHint: '[setup|status|name|room|config|bg|text|on|off|logout|delete-account]',
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

  // The main loop's turn ends while background subagents still work (it waits for them): the
  // break goes on until they are done. A subagent's own turn ending is a cue to look again.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) ctl($).turnComplete(e.isAborted, !e.isAborted && (await agentsBusy($)))
    else void ctl($).agentsChanged()
    return next(e)
  })

  // The Controller opens the pane before `command()` resolves; pinning this hook's `$` makes that
  // open answer the person's command, so it is placed at any width (unasked needs 144 columns).
  on('command.run', { command: 'cbreak' }, async ($, e) => {
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
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const c = controller
    if (!c) return Text({ dimColor: true, children: '☕' })
    // Docked beside the transcript the frame has a fixed height: fill it, so the input is always
    // its bottom row. Inline the frame fits the tree, so the input is the bottom row anyway.
    const fillRows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : 0
    return renderPane(
      c.view(),
      { Box, Text, Input, Button },
      {
        input: (v) => c.input(v),
        submit: (v) => void c.submit(v),
        // A picked emoji row hands the focus back to the input first, then the box goes: the ring
        // follows positions, so redrawing first would leave it on a row that no longer exists.
        pick: (name) => {
          $.ui
            .focus({ requestId: PANE, key: SAY_KEY })
            .catch(() => {})
            .finally(() => c.pickSuggestion(name))
        },
      },
      fillRows,
    )
  })
}
