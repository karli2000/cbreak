import { describe, expect, test } from 'bun:test'
import { Controller, type Line, type PaneView } from '../../plugin/hooks/lib/controller.ts'
import { COPY, errorText } from '../../plugin/hooks/lib/copy.ts'
import type { AuthState, ChatMessage } from '../../plugin/shared/protocol.ts'
import { FakePort, tick } from './fake-port.ts'
import { contrast, NICK_CONTRAST, toRgb } from '../../plugin/hooks/lib/colors.ts'
import { nickColor } from '../../plugin/hooks/lib/format.ts'

const READY: AuthState = { state: 'ready', nickname: 'me', role: 'user', muted_until: null }

async function make(port = new FakePort()): Promise<{ port: FakePort; c: Controller }> {
  const c = new Controller(port)
  await tick()
  return { port, c }
}

/** The helper answers the spawn: hello, auth, joined, backlog. */
async function helperUp(port: FakePort, auth: AuthState = READY, here = 3, backlog: ChatMessage[] = []): Promise<void> {
  await tick()
  port.emit({ type: 'hello', protocol: 1, pid: 42, socket: '/tmp/cb.sock' })
  port.emit({ type: 'auth', ...auth })
  if (auth.state === 'ready') {
    port.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here })
    port.emit({ type: 'backlog', messages: backlog })
  }
  await tick()
}

/** A long turn that has joined the room. */
async function inBreak(port = new FakePort(), auth: AuthState = READY): Promise<{ port: FakePort; c: Controller }> {
  const r = await make(port)
  r.c.turnStart()
  port.advance(15_000)
  await helperUp(port, auth)
  return r
}

function msg(id: number, nickname: string, body = 'hi'): ChatMessage {
  return { id, user_id: `u-${nickname}`, nickname, body, created_at: '2026-11-12T10:00:00Z' }
}

/** The chat view (Task 6 only has chat mode). */
function chat(c: Controller): Extract<PaneView, { mode: 'chat' }> {
  const v = c.view()
  if (v.mode !== 'chat') throw new Error('expected chat mode')
  return v
}

const texts = (c: Controller) => chat(c).lines.map((l) => (l.kind === 'system' ? l.text : `${l.nickname}: ${l.segments.map((s) => s.text).join('')}`))
const lastLine = (c: Controller) => texts(c).at(-1)
const messages = (c: Controller) => chat(c).lines.filter((l): l is Extract<Line, { kind: 'message' }> => l.kind === 'message')

describe('Controller break lifecycle', () => {
  test('a break starts after 15 s of work by default', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(14_999)
    await tick()
    expect(port.spawns).toBe(0)
    port.advance(1)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('short turn never spawns the helper', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(14_000)
    c.turnComplete(false)
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(0)
  })

  test('long turn joins and opens the pane unfocused', async () => {
    const { port, c } = await inBreak()
    expect(port.spawns).toBe(1)
    expect(port.calls[0]).toEqual({ path: '/join', body: { room: 'lobby' } })
    expect(port.opens).toEqual([{ focus: false, title: '☕ lobby · 3 here' }])
    expect(port.lastStatus).toBe('☕ 3 on break')
    expect(port.scrolls).toBe(1)
    expect(c.view()).toMatchObject({ mode: 'chat', header: '☕ lobby · 3 here', busy: true, inputEnabled: true })
  })

  test('the next break of this session asks for the same instance', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'joined', room: 'lobby', instance: 2, topic: 'room:lobby:2', here: 4 })
    c.turnComplete(false)
    port.advance(15_000)
    await tick()
    expect(port.count('/leave')).toBe(1)

    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    const joins = port.calls.filter((x) => x.path === '/join')
    expect(joins.map((x) => x.body)).toEqual([{ room: 'lobby' }, { room: 'lobby', instance: 2 }])

    // another room setting: no preference for a room this session has not been in
    c.turnComplete(false)
    port.advance(15_000)
    await tick()
    expect(await c.command('room other')).toBe('Room set to other. It applies from your next break.')
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.calls.filter((x) => x.path === '/join').at(-1)?.body).toEqual({ room: 'other' })
  })

  test('the grace period shows a countdown until the pane closes', async () => {
    const { port, c } = await inBreak()
    expect(chat(c).countdown).toBeNull()
    c.turnComplete(false)
    expect(chat(c).countdown).toBe('closes in 15 s')
    const redraws = port.redraws
    port.advance(1_000)
    expect(chat(c).countdown).toBe('closes in 14 s')
    expect(port.redraws).toBeGreaterThan(redraws)
    port.advance(13_000)
    expect(chat(c).countdown).toBe('closes in 1 s')
    port.advance(1_000)
    await tick()
    expect(chat(c).countdown).toBeNull()
    expect(port.count('/leave')).toBe(1)
  })

  test('a new turn stops the countdown, unsent text hides it', async () => {
    const { port, c } = await inBreak()
    c.turnComplete(false)
    port.advance(3_000)
    c.turnStart()
    expect(chat(c).countdown).toBeNull()
    port.advance(5_000)
    expect(chat(c).countdown).toBeNull()

    c.turnComplete(false)
    c.input('half a thought')
    expect(lastLine(c)).toBe(COPY.draftKept)
    port.advance(15_000)
    await tick()
    expect(chat(c).countdown).toBeNull()
    expect(port.count('/leave')).toBe(1)
  })

  test('narrow terminal shows the hint', async () => {
    const port = new FakePort()
    port.placed = false
    await inBreak(port)
    expect(port.toasts).toEqual(['☕ 3 on break · /cbreak to join'])
    expect(port.lastStatus).toBe('☕ 3 on break · /cbreak to join')
    expect(port.scrolls).toBe(0)
  })

  test('auto-open off shows the hint without opening', async () => {
    const port = new FakePort()
    port.settings.autoOpen = false
    await inBreak(port)
    expect(port.opens).toEqual([])
    expect(port.lastStatus).toBe('☕ 3 on break · /cbreak to join')
  })

  test('not set up shows the setup hint once', async () => {
    const { port, c } = await make()
    for (let i = 0; i < 2; i++) {
      c.turnStart()
      port.advance(15_000)
      await helperUp(port, { state: 'signed_out' })
      c.turnComplete(false)
      await tick()
    }
    expect(port.toasts).toEqual([COPY.setupHint])
    expect(port.stops).toBe(2)
    expect(port.count('/join')).toBe(0)
  })

  test('banned blocks joins for the session', async () => {
    const { port, c } = await inBreak(new FakePort(), { state: 'banned', nickname: 'me', ban_reason: 'spam' })
    expect(lastLine(c)).toBe(COPY.removed('spam'))
    expect(port.toasts).toEqual([COPY.removed('spam')])
    expect(port.count('/join')).toBe(0)
    expect(port.stops).toBe(1)
    c.turnComplete(false)
    c.turnStart()
    port.advance(30_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('missing hello gives up after 10 s', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(15_000)
    await tick()
    port.advance(10_000)
    await tick()
    expect(lastLine(c)).toBe(COPY.helperGone)
    expect(port.stops).toBe(1)
    expect(port.count('/join')).toBe(0)
  })

  test('claude done leaves after grace', async () => {
    const { port, c } = await inBreak()
    c.turnComplete(false)
    expect(lastLine(c)).toBe('Claude is done, back to work ☕')
    port.advance(14_000)
    await tick()
    expect(port.count('/leave')).toBe(0)
    port.advance(1_000)
    await tick()
    expect(port.count('/leave')).toBe(1)
    expect(port.stops).toBe(1)
    expect(port.closes).toBe(1)
    expect(port.lastStatus).toBeUndefined()
  })

  test('a turn that ends while subagents work keeps the break until they are done', async () => {
    const { port, c } = await inBreak()
    port.agents = true
    c.turnComplete(false, true)
    expect(lastLine(c)).toBe("Claude's subagents are still working ☕")
    expect(c.view()).toMatchObject({ busy: true, countdown: null })
    port.advance(30_000) // grace would have ended; the ping re-checks and finds them working
    await tick()
    expect(port.count('/leave')).toBe(0)
    expect(c.view()).toMatchObject({ busy: true })
    port.agents = false
    await c.agentsChanged() // a subagent's turn ended
    expect(lastLine(c)).toBe('Claude is done, back to work ☕')
    port.advance(15_000)
    await tick()
    expect(port.count('/leave')).toBe(1)
  })

  test('the ping notices subagents are done', async () => {
    const { port, c } = await inBreak()
    port.agents = true
    c.turnComplete(false, true)
    port.agents = false
    port.advance(20_000)
    await tick()
    expect(lastLine(c)).toBe('Claude is done, back to work ☕')
  })

  test('a new turn while waiting for subagents just goes on', async () => {
    const { port, c } = await inBreak()
    port.agents = true
    c.turnComplete(false, true)
    c.turnStart()
    port.agents = false
    await c.agentsChanged()
    expect(lastLine(c)).toBe("Claude's subagents are still working ☕")
    expect(c.view()).toMatchObject({ busy: true })
    c.turnComplete(false)
    expect(lastLine(c)).toBe('Claude is done, back to work ☕')
  })

  test('subagents at the end of a turn keep the pending wait going', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(5_000)
    port.agents = true
    c.turnComplete(false, true)
    port.advance(10_000)
    await tick()
    expect(port.spawns).toBe(1) // the min-wait timer still fired
  })

  test('new turn during grace keeps the room', async () => {
    const { port, c } = await inBreak()
    c.turnComplete(false)
    port.advance(5_000)
    c.turnStart()
    port.advance(15_000)
    await tick()
    expect(port.count('/leave')).toBe(0)
    expect(texts(c)).toContain('Claude is busy again ☕')
    expect(port.spawns).toBe(1)
  })

  test('unsent text does not hold the room: it closes after grace and the text is back at the next break', async () => {
    const { port, c } = await inBreak()
    c.input('typing')
    c.turnComplete(false)
    expect(lastLine(c)).toBe(COPY.draftKept)
    c.input('typing more')
    expect(texts(c).filter((t) => t === COPY.draftKept)).toHaveLength(1)
    port.advance(15_000)
    await tick()
    expect(port.count('/leave')).toBe(1)
    expect(port.closes).toBe(1)

    // next long turn: the break opens with the text still in the input
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.count('/join')).toBe(2)
    expect(chat(c).draft).toBe('typing more')
    expect(texts(c)).toContain(COPY.draftBack)
    await c.submit('typing more')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: 'typing more' } })
    expect(chat(c).draft).toBe('')
  })

  test('a break without unsent text shows neither draft line', async () => {
    const { port, c } = await inBreak()
    c.turnComplete(false)
    port.advance(15_000)
    await tick()
    expect(texts(c)).not.toContain(COPY.draftKept)
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(texts(c)).not.toContain(COPY.draftBack)
  })

  test('sending during the grace period, then leaving at its end', async () => {
    const { port, c } = await inBreak()
    c.input('bye all')
    c.turnComplete(false)
    port.advance(10_000)
    await c.submit('bye all')
    port.advance(5_000)
    await tick()
    expect(port.paths()).toEqual(['/join', '/send', '/leave'])
    expect(chat(c).draft).toBe('')
  })

  test('refused close is retried on next prompt', async () => {
    const { port, c } = await inBreak()
    port.closeResult = false
    c.turnComplete(true)
    port.advance(15_000)
    await tick()
    expect(port.closes).toBe(1)
    port.closeResult = true
    c.promptSubmitted()
    await tick()
    expect(port.closes).toBe(2)
    c.promptSubmitted()
    await tick()
    expect(port.closes).toBe(2)
  })

  test('cbreak while idle refuses', async () => {
    const { port, c } = await make()
    expect(await c.command('')).toBe('☕ The cbreak room is only open while Claude is working.')
    expect(port.spawns).toBe(0)
  })

  test('cbreak while pending joins at once with focus', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(5_000)
    await c.command('')
    await tick()
    expect(port.spawns).toBe(1)
    await helperUp(port)
    // opened inside the command (an asked open); the Port retitles it once `here` is known
    expect(port.opens).toEqual([{ focus: true, title: '☕ lobby · 0 here' }])
    port.advance(30_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('cbreak during a break opens the pane focused', async () => {
    const port = new FakePort()
    port.placed = false
    const { c } = await inBreak(port)
    port.placed = true
    await c.command('')
    await tick()
    expect(port.opens.map((o) => o.focus)).toEqual([false, true])
    expect(port.lastStatus).toBe('☕ 3 on break')
    expect(port.scrolls).toBe(1)
  })

  test('cbreak while joining does not start a second break', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(15_000)
    await tick()
    await c.command('')
    await c.command('')
    await helperUp(port)
    expect(port.spawns).toBe(1)
    expect(port.count('/join')).toBe(1)
    // each /cbreak asks for the pane (focused) before it answers; the join opens nothing more
    expect(port.opens).toEqual([
      { focus: true, title: '☕ lobby · 0 here' },
      { focus: true, title: '☕ lobby · 0 here' },
    ])
  })

  test('cbreak opens the pane focused before it answers', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(5_000)
    expect(await c.command('')).toBe(COPY.opening)
    // the open happened inside the command, before the helper said hello or joined
    expect(port.opens).toEqual([{ focus: true, title: '☕ lobby · 0 here' }])
    expect(port.count('/join')).toBe(0)
    expect(texts(c)).toEqual([COPY.joining])
    await helperUp(port, READY, 3, [msg(1, 'lena')])
    expect(port.opens).toHaveLength(1)
    expect(texts(c)).toEqual(['lena: hi'])
    expect(chat(c).header).toBe('☕ lobby · 3 here')
    expect(port.lastStatus).toBe('☕ 3 on break')
    expect(port.scrolls).toBe(2) // the backlog in the already open pane, then the join
  })

  test('cbreak without setup closes the early pane again', async () => {
    const { port, c } = await make()
    c.turnStart()
    await c.command('')
    await helperUp(port, { state: 'signed_out' })
    expect(port.toasts).toEqual([COPY.setupHint])
    expect(port.closes).toBe(1)
  })

  test('turn ending while the early pane waits for the join closes it', async () => {
    const { port, c } = await make()
    c.turnStart()
    await c.command('')
    c.turnComplete(false)
    await helperUp(port)
    expect(port.count('/join')).toBe(0)
    expect(port.closes).toBe(1)
  })

  test('room commands outside a room answer with a line', async () => {
    const { port, c } = await inBreak()
    port.exit()
    await tick()
    await c.submit('hi')
    expect(port.count('/send')).toBe(0)
    expect(lastLine(c)).toBe(COPY.notInRoom)
  })

  test('closing the pane leaves until the next turn', async () => {
    const { port, c } = await inBreak()
    c.paneClosedByPerson()
    await tick()
    expect(port.count('/leave')).toBe(1)
    expect(port.stops).toBe(1)
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
    c.turnComplete(false)
    c.turnStart()
    port.advance(15_000)
    await tick()
    expect(port.spawns).toBe(2)
    await helperUp(port)
    expect(port.count('/join')).toBe(2)
  })

  test('a repeated turn start after closing the pane does not re-join', async () => {
    const { port, c } = await inBreak()
    c.paneClosedByPerson()
    await tick()
    c.turnStart()
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('cbreak after closing the pane re-joins while busy', async () => {
    const { port, c } = await inBreak()
    c.paneClosedByPerson()
    await tick()
    await c.command('')
    await helperUp(port)
    expect(port.spawns).toBe(2)
    expect(port.opens.at(-1)?.focus).toBe(true)
  })

  test('/leave in the pane leaves and closes', async () => {
    const { port, c } = await inBreak()
    await c.submit('/leave')
    await tick()
    expect(port.paths()).toEqual(['/join', '/leave'])
    expect(port.stops).toBe(1)
    expect(port.closes).toBe(1)
  })

  test('turn ending while /join is in flight leaves only after the join settles', async () => {
    const { port, c } = await make()
    const release = port.hold('/join')
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.paths()).toEqual(['/join'])
    c.turnComplete(false)
    port.advance(10_000) // below the 15 s call timeout
    await tick()
    expect(port.paths()).toEqual(['/join'])
    expect(port.stops).toBe(0)
    release()
    await tick()
    expect(port.paths()).toEqual(['/join', '/leave'])
    expect(port.stops).toBe(1)
    expect(port.opens).toEqual([])
    expect(chat(c).inputEnabled).toBe(false)
    // the next turn starts a fresh break
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.spawns).toBe(2)
    expect(port.count('/join')).toBe(2)
  })

  test('closing the pane while /join is in flight leaves after the join settles', async () => {
    const { port, c } = await make()
    const release = port.hold('/join')
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    c.paneClosedByPerson()
    await tick()
    expect(port.paths()).toEqual(['/join'])
    release()
    await tick()
    expect(port.paths()).toEqual(['/join', '/leave'])
    expect(port.stops).toBe(1)
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('kicked stops for the session', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'kicked', reason: 'spam' })
    await tick()
    expect(lastLine(c)).toBe("You've been removed from cbreak: spam")
    expect(port.stops).toBe(1)
    c.turnComplete(false)
    c.turnStart()
    port.advance(30_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('room closed leaves', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'room_closed' })
    await tick()
    expect(texts(c)).toContain('This room is closed.')
    expect(port.paths()).toEqual(['/join', '/leave'])
    expect(port.stops).toBe(1)
    expect(port.closes).toBe(1)
  })

  test('pings while the helper runs', async () => {
    const { port, c } = await inBreak()
    port.advance(60_000)
    expect(port.count('/ping')).toBe(3)
    c.turnComplete(false)
    port.advance(15_000)
    await tick()
    const pings = port.count('/ping')
    port.advance(60_000)
    expect(port.count('/ping')).toBe(pings)
  })

  test('keeps 200 lines and removes deleted ones', async () => {
    const { port, c } = await inBreak()
    const redraws = port.redraws
    for (let i = 1; i <= 205; i++) port.emit({ type: 'message', ...msg(i, 'lena', `m${i}`) })
    expect(messages(c)).toHaveLength(200)
    expect(messages(c)[0]!.id).toBe(6)
    expect(port.redraws).toBeGreaterThan(redraws)
    port.emit({ type: 'deleted', id: 100 })
    expect(messages(c).map((l) => l.id)).not.toContain(100)
    expect(messages(c)).toHaveLength(199)
  })

  test('message lines carry color, action and mentions', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'message', ...msg(1, 'lena', 'hey @me'), role: 'moderator' })
    port.emit({ type: 'message', ...msg(2, 'ravi', '/me waves') })
    const [a, b] = messages(c)
    expect(a).toMatchObject({ nickname: 'lena', color: '#42d753', action: false, role: 'moderator' })
    expect(a!.segments).toEqual([{ text: 'hey ', mention: false }, { text: '@me', mention: true }])
    expect(b).toMatchObject({ nickname: 'ravi', action: true, segments: [{ text: 'waves', mention: false }] })
  })

  test('backlog fills the lines', async () => {
    const { port, c } = await make()
    c.turnStart()
    port.advance(15_000)
    await helperUp(port, READY, 2, [msg(1, 'lena'), msg(2, 'ravi')])
    expect(messages(c).map((l) => l.id)).toEqual([1, 2])
  })

  test('presence adds lines and updates the count', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'presence', here: 4, joined: ['ravi'], left: [] })
    port.emit({ type: 'presence', here: 3, joined: [], left: ['lena'] })
    expect(texts(c).slice(-2)).toEqual([COPY.joined('ravi'), COPY.left('lena')])
    expect(port.lastStatus).toBe('☕ 3 on break')
    expect(port.statuses).toContain('☕ 4 on break')
    expect(c.view()).toMatchObject({ header: '☕ lobby · 3 here' })
  })

  test('helper events become lines', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'connection', state: 'reconnecting' })
    expect(lastLine(c)).toBe(COPY.reconnecting)
    port.emit({ type: 'error', code: 'realtime_unavailable' })
    expect(lastLine(c)).toBe(COPY.full)
    port.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 3 })
    expect(lastLine(c)).toBe(COPY.full)
    port.emit({ type: 'joined', room: 'lobby', instance: 2, topic: 'room:lobby:2', here: 5 })
    expect(lastLine(c)).toBe(COPY.moved('lobby', 2))
    expect(c.view()).toMatchObject({ header: '☕ lobby · 5 here' })
  })

  test('helper crash during break', async () => {
    const { port, c } = await inBreak()
    port.exit()
    await tick()
    expect(lastLine(c)).toBe(COPY.helperGone)
    expect(port.lastStatus).toBeUndefined()
    expect(chat(c).inputEnabled).toBe(false)
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
    c.turnComplete(false)
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.spawns).toBe(2)
    expect(port.count('/join')).toBe(2)
  })

  test('disabled does nothing', async () => {
    const port = new FakePort()
    port.settings.enabled = false
    const { c } = await make(port)
    c.turnStart()
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(0)
  })

  test('session end leaves and stops', async () => {
    const { port, c } = await inBreak()
    c.sessionEnd()
    await tick()
    expect(port.paths()).toEqual(['/join', '/leave'])
    expect(port.stops).toBe(1)
  })
})

describe('Controller chat', () => {
  test('say sends, clears the draft and scrolls', async () => {
    const { port, c } = await inBreak()
    c.input('hello')
    await c.submit('hello')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: 'hello' } })
    expect(c.view()).toMatchObject({ draft: '' })
    expect(port.scrolls).toBe(2)
  })

  test('/me sends an action body', async () => {
    const { port, c } = await inBreak()
    await c.submit('/me waves')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: '/me waves' } })
  })

  test('send converts emoji', async () => {
    const { port, c } = await inBreak()
    await c.submit('hi :) :tada:')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: 'hi 🙂 🎉' } })
    await c.submit('/me waves <3')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: '/me waves ❤️' } })
  })

  test('emoji off sends as typed', async () => {
    const { port, c } = await inBreak()
    expect(await c.command('config emoji off')).toBe('Saved.')
    await c.submit('hi :)')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: 'hi :)' } })
  })

  test('a draft ending in :token shows the emoji box; a redraw only when the box changes', async () => {
    const { port, c } = await inBreak()
    expect(chat(c).suggestions).toEqual([])
    const r0 = port.redraws
    c.input('hi')
    expect(port.redraws).toBe(r0)
    c.input('hi :smi')
    expect(chat(c).suggestions.map((s) => s.name)).toEqual(['smile', 'smirk', 'smiley', 'smile_cat', 'smirk_cat'])
    expect(port.redraws).toBe(r0 + 1)
    c.input('hi :smile_')
    const r1 = port.redraws
    c.input('hi :smile_c')
    expect(port.redraws).toBe(r1)
    c.input('hi :smile_c ')
    expect(chat(c).suggestions).toEqual([])
    expect(port.redraws).toBe(r1 + 1)
  })

  test('picking a row replaces the :token', async () => {
    const { c } = await inBreak()
    c.input('hi :smi')
    c.pickSuggestion('smirk')
    expect(chat(c).draft).toBe('hi 😏 ')
    expect(chat(c).suggestions).toEqual([])
    // a row from a box that is gone (the draft moved on) changes nothing
    c.input('hi 😏 ok')
    c.pickSuggestion('smile')
    expect(chat(c).draft).toBe('hi 😏 ok')
  })

  test('a picked emoji is sent as it is', async () => {
    const { port, c } = await inBreak()
    c.input(':tad')
    c.pickSuggestion('tada')
    expect(chat(c).draft).toBe('🎉 ')
    await c.submit(chat(c).draft + 'yay')
    expect(port.calls.at(-1)).toEqual({ path: '/send', body: { body: '🎉 yay' } })
  })

  test('new lines scroll the open pane to its end, one scroll per batch, focused or not', async () => {
    const { port, c } = await inBreak()
    const s0 = port.scrolls
    port.emit({ type: 'message', ...msg(1, 'lena') })
    await tick()
    expect(port.scrolls).toBe(s0 + 1)
    port.emit({ type: 'backlog', messages: [msg(2, 'bob'), msg(3, 'zoe'), msg(4, 'tom')] })
    await tick()
    expect(port.scrolls).toBe(s0 + 2)
    port.emit({ type: 'presence', here: 4, joined: ['nina'], left: [] })
    await tick()
    expect(port.scrolls).toBe(s0 + 3)
    // the scroll comes after the redraw that drew the line
    expect(port.redraws).toBeGreaterThan(0)
  })

  test('no scroll while the pane is closed or not placed', async () => {
    const port = new FakePort()
    port.placed = false
    const { c } = await inBreak(port)
    const s0 = port.scrolls
    port.emit({ type: 'message', ...msg(1, 'lena') })
    await tick()
    expect(port.scrolls).toBe(s0)
    expect(texts(c)).toContain('lena: hi')
  })

  test('pane colors: default none; bg and text reach the view at once, nicknames follow the background', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'message', ...msg(1, 'lena') })
    await tick()
    expect(chat(c).colors).toEqual({ bg: null, text: null })
    const plain = messages(c)[0]!.color
    expect(plain).toBe(nickColor('lena'))

    const r0 = port.redraws
    expect(await c.command('config bg #f6efe6')).toBe('Saved.')
    expect(port.redraws).toBeGreaterThan(r0)
    // no text color chosen: a readable one for the background
    expect(chat(c).colors).toEqual({ bg: '#f6efe6', text: '#101010' })
    expect(messages(c)[0]!.color).toBe(nickColor('lena', '#f6efe6'))
    expect(contrast(toRgb(messages(c)[0]!.color)!, toRgb('#f6efe6')!)).toBeGreaterThanOrEqual(NICK_CONTRAST)

    await c.command('config text #2a1c15')
    expect(chat(c).colors).toEqual({ bg: '#f6efe6', text: '#2a1c15' })
    expect(port.saved.at(-1)).toMatchObject({ bg: '#f6efe6', text: '#2a1c15' })

    await c.command('config bg default')
    await c.command('config text default')
    expect(chat(c).colors).toEqual({ bg: null, text: null })
    expect(messages(c)[0]!.color).toBe(plain)
  })

  test('emoji off: no box', async () => {
    const { c } = await inBreak()
    await c.command('config emoji off')
    c.input(':smi')
    expect(chat(c).suggestions).toEqual([])
  })

  test('report reason is not converted', async () => {
    const { port, c } = await inBreak()
    await c.submit('/report lena spam :)')
    expect(port.calls.at(-1)).toMatchObject({ path: '/report', body: { nickname: 'lena', reason: 'spam :)' } })
  })

  test('empty submit does nothing', async () => {
    const { port, c } = await inBreak()
    const before = texts(c).length
    await c.submit('   ')
    expect(port.count('/send')).toBe(0)
    expect(texts(c)).toHaveLength(before)
  })

  test('send errors become lines', async () => {
    const until = new Date(2026, 10, 12, 14, 5).toISOString()
    const { port, c } = await inBreak(new FakePort(), { ...READY, muted_until: until } as AuthState)
    port.answer('/send', { ok: false, code: 'muted' })
    c.input('hi')
    await c.submit('hi')
    expect(lastLine(c)).toBe("You're muted until 14:05.")
    expect(c.view()).toMatchObject({ draft: 'hi' })
  })

  test('report uses the newest message by that nick', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'message', ...msg(4, 'ravi') })
    port.emit({ type: 'message', ...msg(7, 'lena') })
    port.emit({ type: 'message', ...msg(9, 'ravi') })
    await c.submit('/report ravi spam')
    expect(port.calls.at(-1)).toEqual({ path: '/report', body: { nickname: 'ravi', message_id: 9, reason: 'spam' } })
    expect(lastLine(c)).toBe('Reported ravi.')
  })

  test('report without a message sends null', async () => {
    const { port, c } = await inBreak()
    await c.submit('/report ghost rude')
    expect(port.calls.at(-1)).toEqual({ path: '/report', body: { nickname: 'ghost', message_id: null, reason: 'rude' } })
  })

  test('moderator commands are refused for users', async () => {
    const { port, c } = await inBreak()
    await c.submit('/ban ravi x')
    expect(port.paths()).toEqual(['/join'])
    expect(lastLine(c)).toBe("You can't do that.")
  })

  test('moderators can delete, mute and ban', async () => {
    const { port, c } = await inBreak(new FakePort(), { ...READY, role: 'moderator' } as AuthState)
    port.emit({ type: 'message', ...msg(5, 'ravi') })
    await c.submit('/del ravi')
    expect(port.calls.at(-1)).toEqual({ path: '/mod/delete', body: { message_id: 5, reason: '' } })
    await c.submit('/del ghost')
    expect(lastLine(c)).toBe('Not found.')
    expect(port.count('/mod/delete')).toBe(1)
    await c.submit('/mute ravi 1h spam')
    expect(port.calls.at(-1)).toEqual({ path: '/mod/mute', body: { nickname: 'ravi', minutes: 60, reason: 'spam' } })
    await c.submit('/ban ravi spam')
    expect(port.calls.at(-1)).toEqual({ path: '/mod/ban', body: { nickname: 'ravi', reason: 'spam' } })
  })

  test('help shows the mod part only for staff', async () => {
    const { c } = await inBreak()
    await c.submit('/help')
    expect(lastLine(c)).toBe(COPY.paneHelp(false))
    const { c: m } = await inBreak(new FakePort(), { ...READY, role: 'admin' } as AuthState)
    await m.submit('/help')
    expect(lastLine(m)).toBe(COPY.paneHelp(true))
  })

  test('invalid input becomes a line', async () => {
    const { port, c } = await inBreak()
    await c.submit('/nope')
    expect(lastLine(c)).toBe('Unknown command /nope. Type /help.')
    expect(port.paths()).toEqual(['/join'])
  })
})

describe('Controller final-review fixes', () => {
  test('the same helper error twice in a row adds one line (I1)', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'error', code: 'unknown' })
    port.emit({ type: 'error', code: 'unknown' })
    expect(texts(c).filter((t) => t === 'Something went wrong (unknown).')).toHaveLength(1)
  })

  test('connection online after reconnecting adds Reconnected. (M1)', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'connection', state: 'online' })
    expect(texts(c)).not.toContain(COPY.reconnected)
    port.emit({ type: 'connection', state: 'reconnecting' })
    port.emit({ type: 'connection', state: 'online' })
    expect(lastLine(c)).toBe(COPY.reconnected)
    port.emit({ type: 'connection', state: 'online' })
    expect(texts(c).filter((t) => t === COPY.reconnected)).toHaveLength(1)
  })

  test('a hung /join times out after 15 s as network and the teardown is not wedged (M4)', async () => {
    const port = new FakePort()
    const { c } = await make(port)
    port.hold('/join') // never released
    c.turnStart()
    port.advance(15_000)
    await tick()
    port.emit({ type: 'hello', protocol: 1, pid: 42, socket: '/tmp/cb.sock' })
    port.emit({ type: 'auth', ...READY })
    await tick()
    expect(port.count('/join')).toBe(1)
    port.advance(14_999)
    await tick()
    expect(port.stops).toBe(0)
    port.advance(1)
    await tick()
    await tick()
    expect(port.toasts).toContain(errorText('network'))
    expect(port.stops).toBe(1)
  })

  test('a hung /join does not block the teardown queue after the turn ends (M4)', async () => {
    const port = new FakePort()
    const { c } = await make(port)
    port.hold('/join')
    c.turnStart()
    port.advance(15_000)
    await tick()
    port.emit({ type: 'hello', protocol: 1, pid: 42, socket: '/tmp/cb.sock' })
    port.emit({ type: 'auth', ...READY })
    await tick()
    c.turnComplete(false) // teardown waits for the join
    await tick()
    expect(port.stops).toBe(0)
    port.advance(15_000)
    await tick()
    await tick()
    expect(port.stops).toBe(1)
    // a new break can start (it waits for the teardown queue)
    port.answer('/join', { ok: true, data: { room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 2 } })
    c.turnStart()
    port.advance(15_000)
    await helperUp(port)
    expect(port.spawns).toBe(2)
  })

  test('room_lost ends the break with its error line, the pane stays open (M6)', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'room_lost', code: 'not_found' })
    await tick()
    expect(lastLine(c)).toBe('Not found.')
    expect(chat(c).inputEnabled).toBe(false)
    expect(port.lastStatus).toBeUndefined()
    expect(port.stops).toBe(1)
    expect(port.count('/leave')).toBe(0) // the helper already left
    expect(port.closes).toBe(0)
    // no auto re-join in this turn
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
  })

  test('not_in_room has its own text (M6)', () => {
    expect(errorText('not_in_room')).toBe("You're not in the room anymore.")
  })
})

const BUN_LINE = 'cbreak needs Bun. Install it with: curl -fsSL https://bun.sh/install | bash — then restart Claude Code.'

describe('Controller without Bun (ruling R2)', () => {
  test('needsBun copy is exact and errorText maps no_bun to it', () => {
    expect(COPY.needsBun).toBe(BUN_LINE)
    expect(errorText('no_bun')).toBe(BUN_LINE)
  })

  test('no_bun at break start shows the Bun line once, spawns nothing more that turn and toasts once per session', async () => {
    const port = new FakePort()
    port.noBun = true
    const { c } = await make(port)
    c.turnStart()
    port.advance(15_000)
    await tick()
    expect(port.spawns).toBe(1)
    expect(port.toasts).toEqual([BUN_LINE])
    expect(texts(c).filter((t) => t === BUN_LINE)).toHaveLength(1)
    expect(texts(c)).not.toContain(COPY.helperGone)
    expect(port.opens).toEqual([])

    // the same turn: /cbreak answers the Bun line without another spawn, nothing more appears
    expect(await c.command('')).toBe(BUN_LINE)
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
    expect(port.toasts).toEqual([BUN_LINE])
    expect(port.opens).toEqual([])

    // the next turn tries once more, but the automatic toast is once per session (like the setup hint)
    c.turnComplete(false)
    c.turnStart()
    port.advance(15_000)
    await tick()
    expect(port.spawns).toBe(2)
    expect(port.toasts).toEqual([BUN_LINE])
    c.turnComplete(false)
    c.turnStart()
    port.advance(15_000)
    await tick()
    expect(port.spawns).toBe(3)
    expect(port.toasts).toEqual([BUN_LINE])

    // a bare /cbreak still answers the Bun line every time
    expect(await c.command('')).toBe(BUN_LINE)
    expect(await c.command('')).toBe(BUN_LINE)
  })

  test('/cbreak while pending without Bun closes the early pane and shows the Bun line', async () => {
    const port = new FakePort()
    port.noBun = true
    const { c } = await make(port)
    c.turnStart()
    expect(await c.command('')).toBe(COPY.opening)
    await tick()
    expect(port.spawns).toBe(1)
    expect(port.toasts).toEqual([BUN_LINE])
    expect(port.closes).toBe(1)
    expect(await c.command('')).toBe(BUN_LINE)
    expect(port.spawns).toBe(1)
  })

  test('once no Bun is known, /cbreak in a later turn answers the Bun line without opening the pane', async () => {
    const port = new FakePort()
    port.noBun = true
    const { c } = await make(port)
    expect(await c.command('setup')).toBe(BUN_LINE) // learnt from a lease
    c.turnStart()
    expect(await c.command('')).toBe(BUN_LINE)
    expect(port.opens).toEqual([])
    expect(port.spawns).toBe(1)
    // the reply was the line for this turn: the automatic start does not toast it again
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
    expect(port.toasts).toEqual([])
  })
})
