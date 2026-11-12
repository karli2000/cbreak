// @ts-check
// Spike S1 (throwaway): does a mod pane work as Coffee Break's chat window?
//
// - turn.start (main agent only) waits 5 s, then opens the pane `coffee-spike`
//   with a message list and an Input, and starts `bun ticker.ts` with
//   $.process.spawn. Each JSON line the ticker prints is rendered.
// - Input onSubmit appends `me: <text>` locally and POSTs the text to the
//   ticker over 127.0.0.1 and over its Unix socket ($.http.fetch), which
//   echoes it back on stdout. That answers "can the mod talk to the helper?".
// - turn.complete shows "back to work" and closes the pane 5 s later, unless
//   the Input holds text.
// - /coffee-spike opens the pane by hand (`/coffee-spike close` closes it,
//   `/coffee-spike ping` sends "ping" to the ticker without typing).
//
// Every event the mod sees is appended as one JSON line to spike.log next to
// this plugin's .claude-plugin folder ($.plugin.root/spike.log).
//
// Written as plain JS with h(...) calls (no JSX), so the brief's register.js
// name holds. Validation rule: $ is only ever passed to top-level functions.

const PANE = 'coffee-spike'
const TITLE = '☕ coffee spike'
const OPEN_DELAY_MS = 5000
const CLOSE_DELAY_MS = 5000
const MAX_MESSAGES = 200
const MAX_LOG_LINES = 5000
const READY_HINT = '☕ coffee spike ready · /coffee-spike to open'

/** @typedef {import('claude-code').EngineInterface} Engine */
/** @typedef {import('claude-code').Timer} Timer */
/** @typedef {{ nick: string, body: string }} Line */
/**
 * @typedef {{
 *   stream: import('claude-code').HookStream<import('claude-code').ProcessSpawnChunk, import('claude-code').ProcessSpawnResult>,
 *   argv: string[], startedAt: number, pid: number | null, port: number | null,
 *   socket: string | null, ticks: number, stopping: boolean
 * }} Ticker
 */

// Module state. A hot reload resets it; fine for a spike.
let busy = false
/** @type {'closed' | 'waiting' | 'placed'} */
let paneState = 'closed'
/** @type {Timer | null} */
let openTimer = null
/** @type {Timer | null} */
let closeTimer = null
/** @type {Line[]} */
let messages = []
let draft = ''
/** @type {Ticker | null} */
let ticker = null
let lastViewport = ''
/** @type {string[] | null} */
let logLines = null
/** @type {Promise<void>} */
let logChain = Promise.resolve()

// ---------- logging ----------

/**
 * @param {Engine} $
 * @param {string} event
 * @param {Record<string, unknown>} [data]
 */
function log($, event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data })
  logChain = logChain.then(() => appendLog($, line)).catch(() => {})
  return logChain
}

/**
 * @param {Engine} $
 * @param {string} line
 */
async function appendLog($, line) {
  const path = `${$.plugin.root}/spike.log`
  if (logLines === null) {
    logLines = []
    try {
      if (await $.fs.exists(path)) {
        logLines = (await $.fs.read(path)).split('\n').filter(Boolean)
      }
    } catch {}
  }
  logLines.push(line)
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES)
  await $.fs.write(path, logLines.join('\n') + '\n')
}

/** @param {unknown} err */
function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

// ---------- display ----------

/** @param {Engine} $ */
function setStatus($) {
  if (paneState === 'waiting') {
    $.ui.status(READY_HINT)
    return
  }
  const pane = paneState === 'placed' ? 'pane open' : 'pane closed'
  const tick = ticker ? `ticker pid ${ticker.pid ?? '?'} (${ticker.ticks} ticks)` : 'ticker stopped'
  $.ui.status(`☕ spike: ${pane} · ${tick} · Claude ${busy ? 'busy' : 'idle'}`)
}

/**
 * @param {Engine} $
 * @param {string} nick
 * @param {string} body
 */
function pushMessage($, nick, body) {
  messages.push({ nick, body })
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  if (paneState !== 'closed') {
    $.ui.invalidate('ui.render')
    scrollToInput($)
  }
}

/**
 * Keep the entry field in view: scroll the pane so the Input (key 'say')
 * sits at the bottom edge after each redraw that adds a line.
 * @param {Engine} $
 */
function scrollToInput($) {
  try {
    $.clock.after(50, () => {
      $.ui.scroll({ in: PANE, to: { key: 'say' }, block: 'end' }).then(
        r => { if (r && r.deny) void log($, 'scroll.deny', { deny: String(r.deny) }) },
        err => void log($, 'scroll.error', { error: errText(err) }),
      )
    })
  } catch {}
}

/**
 * Stable per-nickname color: FNV-1a hash of the lowercased nick → hue,
 * fixed saturation/lightness so every color stays readable on dark and light themes.
 * @param {string} nick
 */
function nickColor(nick) {
  let h = 0x811c9dc5
  for (const ch of nick.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const hue = h % 360
  return hslToHex(hue, 65, 55)
}

/** @param {number} h @param {number} s @param {number} l */
function hslToHex(h, s, l) {
  s /= 100; l /= 100
  const k = (/** @type {number} */ n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (/** @type {number} */ x) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

// ---------- pane ----------

/**
 * @param {Engine} $
 * @param {string} why
 * @param {boolean} focus
 */
async function openPane($, why, focus) {
  if (closeTimer) {
    closeTimer.cancel()
    closeTimer = null
  }
  /** @type {import('claude-code').PaneOpenArgs} */
  const args = focus ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE }
  let res
  try {
    res = await $.ui.open(args)
  } catch (err) {
    await log($, 'ui.open.error', { why, error: errText(err) })
    return
  }
  if (res.isPlaced) {
    paneState = 'placed'
    await log($, 'ui.open', { why, focus, isPlaced: true })
    scrollToInput($)
  } else {
    paneState = 'waiting'
    await log($, 'ui.open', { why, focus, isPlaced: false, reason: res.reason })
    $.ui.toast(READY_HINT, { timeoutMs: 8000 })
  }
  await startTicker($, why)
  setStatus($)
}

/**
 * @param {Engine} $
 * @param {string} why
 */
async function closePane($, why) {
  await log($, 'ui.close.request', { why })
  try {
    await $.ui.close({ id: PANE })
  } catch (err) {
    await log($, 'ui.close.error', { why, error: errText(err) })
  }
}

// ---------- ticker (stand-in for coffeebreakd) ----------

/**
 * @param {Engine} $
 * @param {string} why
 */
async function startTicker($, why) {
  if (ticker) return
  const argv = ['bun', `${$.plugin.root}/ticker.ts`]
  const stream = $.process.spawn({ argv })
  ticker = {
    stream,
    argv,
    startedAt: Date.now(),
    pid: null,
    port: null,
    socket: null,
    ticks: 0,
    stopping: false,
  }
  await log($, 'spawn.start', { why, argv })
  void pump($, ticker)
}

/**
 * Reads the ticker's output until it ends. Leaving this loop (or return() on
 * the stream, or the module unloading) is what kills the child.
 *
 * @param {Engine} $
 * @param {Ticker} t
 */
async function pump($, t) {
  let buf = ''
  let stderr = ''
  try {
    for await (const chunk of t.stream) {
      if (t.stopping) break
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-2000)
        continue
      }
      buf += chunk.text
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        handleLine($, t, buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
    }
    let result = null
    if (!t.stopping) {
      try {
        result = await t.stream.result
      } catch {}
    }
    await log($, 'spawn.exit', {
      pid: t.pid,
      ticks: t.ticks,
      stoppedByMod: t.stopping,
      result,
      ranMs: Date.now() - t.startedAt,
      stderr: stderr || undefined,
    })
  } catch (err) {
    await log($, 'spawn.error', {
      pid: t.pid,
      ticks: t.ticks,
      error: errText(err),
      stderr: stderr || undefined,
    })
    pushMessage($, '☕', `ticker failed: ${errText(err)}`)
  } finally {
    if (ticker === t) ticker = null
    setStatus($)
  }
}

/**
 * @param {Engine} $
 * @param {Ticker} t
 * @param {string} raw
 */
function handleLine($, t, raw) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    void log($, 'spawn.badline', { raw: raw.slice(0, 200) })
    return
  }
  if (msg.type === 'hello') {
    t.pid = msg.pid
    t.port = msg.port
    t.socket = msg.socket
    void log($, 'spawn.hello', { pid: msg.pid, port: msg.port, socket: msg.socket })
    setStatus($)
    return
  }
  if (msg.type === 'message') {
    if (msg.nick === 'bot') {
      t.ticks += 1
      if (t.ticks === 1 || t.ticks % 30 === 0) void log($, 'spawn.tick', { pid: t.pid, n: t.ticks })
      if (t.ticks % 5 === 0) setStatus($)
    } else {
      void log($, 'spawn.echo', { nick: msg.nick, len: String(msg.body).length })
    }
    pushMessage($, String(msg.nick), String(msg.body))
  }
}

/**
 * @param {Engine} $
 * @param {string} why
 */
function stopTicker($, why) {
  const t = ticker
  if (!t) return
  t.stopping = true
  ticker = null
  void log($, 'spawn.stop', { why, pid: t.pid })
  // return() on the stream kills the child (types: "leaving it, return() on
  // the stream ... kills the child"). Not awaited: it settles once the
  // pending read does, up to a second later.
  t.stream.return(/** @type {any} */ (undefined)).then(
    () => log($, 'spawn.stop.done', { pid: t.pid }),
    err => log($, 'spawn.stop.error', { pid: t.pid, error: errText(err) }),
  )
}

/**
 * Q5: the mod can't write to a spawned child's stdin after start, so try
 * $.http.fetch to the child over loopback TCP and over its Unix socket.
 *
 * @param {Engine} $
 * @param {string} text
 */
async function sendToTicker($, text) {
  const t = ticker
  if (!t || t.port === null) {
    await log($, 'fetch.skipped', { why: 'no ticker port yet' })
    return
  }
  const started = Date.now()
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${t.port}/say`, { method: 'POST', body: text })
    await log($, 'fetch.tcp', { status: res.status, ok: res.ok, ms: Date.now() - started })
    if (!res.ok) pushMessage($, '☕', `tcp fetch: HTTP ${res.status}`)
  } catch (err) {
    await log($, 'fetch.tcp.error', { error: errText(err), ms: Date.now() - started })
    pushMessage($, '☕', `tcp fetch refused: ${errText(err)}`)
  }
  if (t.socket === null) return
  const started2 = Date.now()
  try {
    const res = await $.http.fetch('http://localhost/say', {
      method: 'POST',
      body: text,
      socketPath: t.socket,
    })
    await log($, 'fetch.unix', { status: res.status, ok: res.ok, ms: Date.now() - started2 })
    if (!res.ok) pushMessage($, '☕', `unix fetch: HTTP ${res.status}`)
  } catch (err) {
    await log($, 'fetch.unix.error', { error: errText(err), ms: Date.now() - started2 })
    pushMessage($, '☕', `unix fetch refused: ${errText(err)}`)
  }
}

// ---------- hooks ----------

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'coffee-spike',
      description: 'Open the Coffee Break spike pane (`close` closes it, `ping` tests $.http.fetch)',
      argumentHint: '[close|ping]',
      immediate: true,
    })
    await log($, 'session.start', { root: $.plugin.root })
    setStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await log($, 'session.end', { reason: e.reason, tickerPid: ticker?.pid ?? null })
    stopTicker($, `session.end (${e.reason})`)
    return next(e)
  })

  // Q2/Q6: every submitted prompt, to compare with turn.start and to spot
  // pane text leaking into the prompt.
  on('prompt.submit', async ($, e, next) => {
    await log($, 'prompt.submit', {
      len: e.text.length,
      head: e.text.slice(0, 40),
      isMeta: e.isMeta ?? false,
      command: e.command?.name,
      busy,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await log($, 'turn.start', {
      turnId: e.turnId,
      agentId: e.agentId ?? null,
      textLen: e.text.length,
      head: e.text.slice(0, 40),
      wasBusy: busy,
      paneState,
    })
    if (e.agentId !== undefined) return next(e)

    busy = true
    if (closeTimer) {
      closeTimer.cancel()
      closeTimer = null
      void log($, 'close.cancelled', { why: 'new turn started' })
      pushMessage($, '☕', 'Claude is busy again')
    }
    if (paneState === 'closed' && !openTimer) {
      openTimer = $.clock.after(OPEN_DELAY_MS, () => {
        openTimer = null
        if (busy && paneState === 'closed') void openPane($, 'turn.start +5s', false)
        else void log($, 'open.skipped', { busy, paneState })
      })
    }
    setStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await log($, 'turn.complete', {
      turnId: e.turnId,
      agentId: e.agentId ?? null,
      reason: e.reason,
      isAborted: e.isAborted,
      durationMs: e.durationMs,
      paneState,
      draftLen: draft.length,
    })
    if (e.agentId !== undefined) return next(e)

    busy = false
    if (openTimer) {
      openTimer.cancel()
      openTimer = null
      void log($, 'open.cancelled', { why: 'turn ended within 5 s' })
    }
    if (paneState !== 'closed') {
      pushMessage($, '☕', `back to work${e.isAborted ? ' (interrupted)' : ''}, closing in 5 s`)
      if (closeTimer) closeTimer.cancel()
      closeTimer = $.clock.after(CLOSE_DELAY_MS, () => {
        closeTimer = null
        if (busy) {
          void log($, 'close.skipped', { why: 'busy again' })
        } else if (draft.trim() !== '') {
          void log($, 'close.skipped', { why: 'input has text', draftLen: draft.length })
          pushMessage($, '☕', 'kept open: you have unsent text')
        } else {
          void closePane($, 'turn.complete +5s')
        }
      })
    }
    setStatus($)
    return next(e)
  })

  on('command.run', { command: 'coffee-spike' }, async ($, e) => {
    await log($, 'command.run', {
      args: e.args,
      columns: e.presentation.columns,
      isFullscreen: e.presentation.isFullscreen,
    })
    if (e.args.trim() === 'close') {
      await closePane($, 'command')
      return { text: 'Coffee spike pane closed.' }
    }
    if (e.args.trim() === 'ping') {
      // Q5 without typing: open, wait for the ticker's port, POST "ping" over
      // TCP and the Unix socket, report which echoes came back.
      await openPane($, 'command ping', false)
      for (let i = 0; i < 30 && !(ticker && ticker.port !== null); i++) await $.clock.sleep(100)
      await sendToTicker($, 'ping')
      await $.clock.sleep(500)
      const echoes = messages.filter(m => m.nick.startsWith('echo-')).map(m => m.nick)
      await log($, 'ping.result', { echoes })
      return { text: `ping sent; echoes received: ${echoes.join(', ') || 'none'}` }
    }
    await openPane($, 'command', true)
    return { text: 'Coffee spike pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await log($, 'ui.close', { origin: e.origin.kind, tickerPid: ticker?.pid ?? null })
    const res = await next(e)
    paneState = 'closed'
    draft = ''
    lastViewport = ''
    stopTicker($, `pane closed (${e.origin.kind})`)
    setStatus($)
    return res
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const vp = e.viewport
    const view = `${vp?.columns ?? '?'}x${vp?.rows ?? '?'} fullscreen=${vp?.isFullscreen} placement=${e.props.placement} body=${e.props.bodyColumns}`
    if (view !== lastViewport || paneState === 'waiting') {
      const latePlacement = paneState === 'waiting'
      lastViewport = view
      if (latePlacement) paneState = 'placed'
      // No writes while drawing: log and status on the next tick.
      try {
        $.clock.after(0, () => {
          void log($, 'pane.render', { view, latePlacement })
          setStatus($)
        })
      } catch {}
    }

    const room = Math.max(3, (vp?.rows ?? 24) - 8)
    const header = busy ? 'Claude is working. Chat while you wait.' : 'Claude is done.'
    // h() is typed as returning RenderNode | null | undefined; a Box is an element.
    return /** @type {import('claude-code').RenderElement} */ (h(
      Box,
      { flexDirection: 'column' },
      h(Text, { dimColor: true }, header),
      ...messages
        .slice(-room)
        .map(m =>
          m.nick === '☕'
            ? h(Text, { dimColor: true }, `${m.nick}: ${m.body}`)
            : h(Text, {}, h(Text, { color: nickColor(m.nick), bold: true }, m.nick), `: ${m.body}`),
        ),
      h(Input, {
        key: 'say',
        placeholder: 'say something',
        submitLabel: 'send',
        value: draft,
        /** @param {string} value */
        onInput: value => {
          draft = value
          void log($, 'input.change', { len: value.length, tail: value.slice(-20) })
        },
        /** @param {string} value */
        onSubmit: value => {
          const text = value.trim()
          void log($, 'input.submit', { len: value.length })
          draft = ''
          if (text === '') {
            $.ui.invalidate('ui.render')
            return
          }
          pushMessage($, 'me', text)
          $.ui.invalidate('ui.render')
          void sendToTicker($, text)
        },
      }),
    ))
  })
}
