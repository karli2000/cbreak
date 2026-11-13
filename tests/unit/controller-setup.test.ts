import { describe, expect, test } from 'bun:test'
import { Controller, type PaneView } from '../../plugin/hooks/lib/controller.ts'
import { COPY, errorText } from '../../plugin/hooks/lib/copy.ts'
import type { AuthState } from '../../plugin/shared/protocol.ts'
import { FakePort, tick } from './fake-port.ts'

const READY: AuthState = { state: 'ready', nickname: 'lena', role: 'user', muted_until: null }

async function make(port = new FakePort()): Promise<{ port: FakePort; c: Controller }> {
  const c = new Controller(port)
  await tick()
  return { port, c }
}

/** The latest spawned fake helper says hello and reports its auth state. */
async function helperUp(port: FakePort, auth: AuthState): Promise<void> {
  await tick()
  port.emit({ type: 'hello', protocol: 1, pid: 42, socket: '/tmp/cb.sock' })
  port.emit({ type: 'auth', ...auth })
  await tick()
}

/** Runs `/coffee <args>` with a freshly spawned helper reporting `auth`. */
async function run(port: FakePort, c: Controller, args: string, auth: AuthState = READY): Promise<string> {
  const reply = c.command(args)
  await helperUp(port, auth)
  return reply
}

/** A long turn that has joined the room. */
async function inBreak(port = new FakePort()): Promise<{ port: FakePort; c: Controller }> {
  const r = await make(port)
  r.c.turnStart()
  port.advance(20_000)
  await helperUp(port, READY)
  port.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 3 })
  await tick()
  return r
}

function setup(c: Controller): Extract<PaneView, { mode: 'setup' }> {
  const v = c.view()
  if (v.mode !== 'setup') throw new Error(`expected setup mode, got ${v.mode}`)
  return v
}

const SETTINGS_LINE = 'Room: lobby · min wait 20 s · grace 15 s · auto-open on · emoji on · enabled'

describe('Controller setup flow', () => {
  test('setup walks sign-in, nickname, rules', async () => {
    const { port, c } = await make()
    expect(await run(port, c, 'setup', { state: 'signed_out' })).toBe(COPY.setupOpening)
    expect(port.opens).toEqual([{ focus: true, title: COPY.setupTitle }])
    expect(setup(c).lines).toContain(COPY.signin)
    expect(setup(c).placeholder).toBe(COPY.setupPlaceholder.signin)

    await c.submit('')
    expect(port.paths()).toEqual(['/login'])
    port.emit({ type: 'login', url: 'https://github.com/login/x' })
    expect(setup(c).lines).toContain(COPY.loginUrl('https://github.com/login/x'))

    port.emit({ type: 'auth', state: 'needs_nickname' })
    expect(setup(c).lines).toContain(COPY.pickNick)
    expect(setup(c).placeholder).toBe(COPY.setupPlaceholder.nick)
    c.input('ab')
    expect(setup(c).lines).toContain(errorText('nickname_invalid'))
    expect(setup(c).draft).toBe('ab')
    port.advance(1_000)
    expect(port.count('/nickname/check')).toBe(0)

    port.answer('/nickname/check', { ok: true, data: { available: true } })
    c.input('Len')
    c.input('Lena')
    expect(setup(c).lines).not.toContain(errorText('nickname_invalid'))
    port.advance(399)
    expect(port.count('/nickname/check')).toBe(0)
    port.advance(1)
    await tick()
    expect(port.calls.filter((x) => x.path === '/nickname/check')).toEqual([{ path: '/nickname/check', body: { nick: 'lena' } }])
    expect(setup(c).lines).toContain('✓ lena is available')

    await c.submit('Lena')
    expect(port.calls.at(-1)).toEqual({ path: '/nickname/claim', body: { nick: 'lena' } })

    port.emit({ type: 'auth', state: 'needs_rules', nickname: 'lena' })
    expect(setup(c).lines).toContain(COPY.rules)
    const calls = port.calls.length
    await c.submit('no')
    expect(port.calls).toHaveLength(calls)
    expect(setup(c).lines.filter((l) => l === COPY.rules)).toHaveLength(2)
    await c.submit('YES')
    expect(port.calls.at(-1)?.path).toBe('/rules/accept')

    port.emit({ type: 'auth', ...READY })
    await tick()
    expect(setup(c).lines).toContain(COPY.ready('lena', 20))
    expect(port.stops).toBe(1)
    expect(port.alive).toBe(false)
    expect(port.count('/join')).toBe(0)
  })

  test('taken nickname and claim errors show in the pane', async () => {
    const { port, c } = await make()
    await run(port, c, 'setup', { state: 'needs_nickname' })
    port.answer('/nickname/check', { ok: true, data: { available: false } })
    c.input('ravi')
    port.advance(400)
    await tick()
    expect(setup(c).lines).toContain('✗ ravi is taken')
    port.answer('/nickname/claim', { ok: false, code: 'nickname_taken' })
    await c.submit('ravi')
    expect(setup(c).lines).toContain('That name is taken.')
    await c.submit('x')
    expect(port.count('/nickname/claim')).toBe(1)
  })

  test('a stale nickname check is ignored', async () => {
    const { port, c } = await make()
    await run(port, c, 'setup', { state: 'needs_nickname' })
    port.answer('/nickname/check', { ok: true, data: { available: true } })
    const release = port.hold('/nickname/check')
    c.input('lena')
    port.advance(400)
    c.input('ab')
    release()
    await tick()
    expect(setup(c).lines).not.toContain('✓ lena is available')
    expect(setup(c).lines).toContain(errorText('nickname_invalid'))
  })

  test('login failure shows in the pane', async () => {
    const { port, c } = await make()
    await run(port, c, 'setup', { state: 'signed_out' })
    port.emit({ type: 'error', code: 'login_failed' })
    expect(setup(c).lines).toContain(errorText('login_failed'))
  })

  test('setup when already signed in', async () => {
    const { port, c } = await make()
    expect(await run(port, c, 'setup')).toBe("You're signed in as lena.")
    expect(port.opens).toEqual([])
    expect(port.stops).toBe(1)
    expect(c.view().mode).toBe('chat')
  })

  test('setup when banned', async () => {
    const { port, c } = await make()
    expect(await run(port, c, 'setup', { state: 'banned', nickname: 'lena', ban_reason: 'spam' })).toBe(COPY.removed('spam'))
    expect(port.stops).toBe(1)
  })

  test('setup while busy starts the break when ready', async () => {
    const { port, c } = await make()
    c.turnStart()
    await run(port, c, 'setup', { state: 'needs_rules', nickname: 'lena' })
    port.advance(20_000) // the min-busy timer does not start a break while the setup runs
    await tick()
    expect(port.count('/join')).toBe(0)
    expect(port.toasts).toEqual([])
    await c.submit('yes')
    port.emit({ type: 'auth', ...READY })
    await tick()
    expect(port.count('/join')).toBe(1)
    expect(port.spawns).toBe(1)
    expect(port.stops).toBe(0)
    port.emit({ type: 'joined', room: 'lobby', instance: 1, topic: 'room:lobby:1', here: 2 })
    await tick()
    expect(c.view()).toMatchObject({ mode: 'chat', header: '☕ lobby · 2 here' })
    expect(port.opens.at(-1)?.focus).toBe(true)
  })

  test('setup while busy and signed in opens the chat pane before it answers', async () => {
    const { port, c } = await make()
    c.turnStart()
    expect(await run(port, c, 'setup')).toBe("You're signed in as lena.")
    expect(port.opens).toEqual([{ focus: true, title: '☕ lobby · 0 here' }])
    expect(port.count('/join')).toBe(1)
  })

  test('coffee during a setup focuses the setup', async () => {
    const { port, c } = await make()
    c.turnStart()
    await run(port, c, 'setup', { state: 'signed_out' })
    expect(await c.command('')).toBe(COPY.setupRunning)
    await tick()
    expect(port.opens).toEqual([
      { focus: true, title: COPY.setupTitle },
      { focus: true, title: COPY.setupTitle },
    ])
    expect(port.spawns).toBe(1)
    expect(port.count('/join')).toBe(0)
  })

  test('setup during a break uses the break helper', async () => {
    const { port, c } = await inBreak()
    expect(await c.command('setup')).toBe("You're signed in as lena.")
    expect(port.spawns).toBe(1)
    expect(port.stops).toBe(0)
  })

  test('closing the setup pane stops the helper', async () => {
    const { port, c } = await make()
    await run(port, c, 'setup', { state: 'signed_out' })
    c.paneClosedByPerson()
    await tick()
    expect(port.stops).toBe(1)
    expect(c.view().mode).toBe('chat')
  })

  test('setup helper that dies is reported', async () => {
    const { port, c } = await make()
    await run(port, c, 'setup', { state: 'signed_out' })
    port.exit()
    await tick()
    expect(setup(c).lines.at(-1)).toBe(COPY.setupGone)
  })

  test('setup when the helper does not start', async () => {
    const { port, c } = await make()
    const reply = c.command('setup')
    await tick()
    port.advance(10_000)
    expect(await reply).toBe(COPY.helperUnavailable)
    expect(port.stops).toBe(1)
  })
})

const BUN_LINE = 'Coffee Break needs Bun. Install it with: curl -fsSL https://bun.sh/install | bash — then restart Claude Code.'

describe('Controller setup: Bun', () => {
  test('/coffee setup without bun answers the Bun line', async () => {
    const port = new FakePort()
    port.noBun = true
    const { c } = await make(port)
    expect(await c.command('setup')).toBe(BUN_LINE)
    expect(port.opens).toEqual([])
    expect(port.calls).toEqual([])
    // the other subcommands that need the helper answer it too
    expect(await c.command('name lena')).toBe(BUN_LINE)
    expect(await c.command('logout')).toBe(BUN_LINE)
    expect(await c.command('status')).toBe(`${BUN_LINE}\n${SETTINGS_LINE}\nOn break: no`)
    expect(c.view().mode).toBe('chat')
  })
})

describe('Controller /coffee commands', () => {
  test('status signed in', async () => {
    const port = new FakePort()
    port.answer('/status', { ok: true, data: { auth: { ...READY, role: 'moderator' }, room: null } })
    const { c } = await make(port)
    expect(await run(port, c, 'status')).toBe(`Signed in as lena (moderator)\n${SETTINGS_LINE}\nOn break: no`)
    expect(port.paths()).toEqual(['/status'])
    expect(port.stops).toBe(1)
  })

  test('status signed out and during a break', async () => {
    const port = new FakePort()
    port.answer('/status', { ok: true, data: { auth: { state: 'signed_out' }, room: null } })
    const { c } = await make(port)
    expect(await run(port, c, 'status', { state: 'signed_out' })).toBe(`Not signed in\n${SETTINGS_LINE}\nOn break: no`)
    const b = await inBreak()
    b.port.answer('/status', { ok: true, data: { auth: READY, room: null } })
    expect((await b.c.command('status')).split('\n').at(-1)).toBe('On break: yes')
    expect(b.port.spawns).toBe(1)
    expect(b.port.stops).toBe(0)
  })

  test('name change maps errors', async () => {
    const { port, c } = await make()
    port.answer('/nickname/claim', { ok: false, code: 'nickname_change_too_soon' })
    expect(await run(port, c, 'name lena2')).toBe('You can change your name once every 30 days.')
    port.answer('/nickname/claim', { ok: true, data: { nickname: 'lena2' } })
    expect(await run(port, c, 'name Lena2')).toBe('Your nickname is now lena2.')
    expect(port.calls.at(-1)).toEqual({ path: '/nickname/claim', body: { nick: 'lena2' } })
    expect(port.stops).toBe(2)
    expect(await c.command('name x')).toBe(errorText('nickname_invalid'))
    expect(port.spawns).toBe(2)
  })

  test('room validates and saves', async () => {
    const { port, c } = await make()
    expect(await c.command('room x')).toBe('Room names are 2–32 characters: a–z, 0–9 and -.')
    expect(port.saved).toEqual([])
    expect(await c.command('room Lobby-DE')).toBe('Room set to lobby-de. It applies from your next break.')
    expect(port.saved.at(-1)).toMatchObject({ room: 'lobby-de' })
    expect(port.spawns).toBe(0)
  })

  test('config shows and sets', async () => {
    const { port, c } = await make()
    expect(await c.command('config')).toBe(SETTINGS_LINE)
    expect(await c.command('config grace 30')).toBe('Saved.')
    expect(port.saved.at(-1)).toMatchObject({ graceSec: 30 })
    expect(await c.command('config min-wait 5')).toBe('Saved.')
    expect(await c.command('config auto-open off')).toBe('Saved.')
    expect(await c.command('config')).toBe('Room: lobby · min wait 5 s · grace 30 s · auto-open off · emoji on · enabled')
  })

  test('off during a break leaves', async () => {
    const { port, c } = await inBreak()
    expect(await c.command('off')).toBe('Coffee break is off. /coffee on turns it back on.')
    await tick()
    expect(port.saved.at(-1)).toMatchObject({ enabled: false })
    expect(port.count('/leave')).toBe(1)
    expect(port.stops).toBe(1)
    expect(port.closes).toBe(1)
    c.turnComplete(false)
    c.turnStart()
    port.advance(60_000)
    await tick()
    expect(port.spawns).toBe(1)
    expect(await c.command('')).toBe('Coffee break is off. /coffee on turns it back on.')
    expect(await c.command('on')).toBe('Coffee break is on.')
    expect(port.saved.at(-1)).toMatchObject({ enabled: true })
  })

  test('logout', async () => {
    const { port, c } = await make()
    expect(await run(port, c, 'logout')).toBe('Signed out.')
    expect(port.paths()).toEqual(['/logout'])
    expect(port.stops).toBe(1)
  })

  test('logout during a break leaves first', async () => {
    const { port, c } = await inBreak()
    const reply = c.command('logout')
    await helperUp(port, READY)
    expect(await reply).toBe('Signed out.')
    expect(port.paths()).toEqual(['/join', '/leave', '/logout'])
    expect(port.closes).toBe(1)
    expect(port.alive).toBe(false)
  })

  test('delete-account needs yes', async () => {
    const { port, c } = await make()
    expect(await c.command('delete-account')).toBe(COPY.deleteWarn)
    expect(port.spawns).toBe(0)
    expect(await run(port, c, 'delete-account yes')).toBe('Your coffee break profile was deleted.')
    expect(port.paths()).toEqual(['/delete-account'])
    expect(port.stops).toBe(1)
  })

  test('invalid lists the commands', async () => {
    const { c } = await make()
    expect(await c.command('bogus')).toBe(
      'Unknown command "bogus". Try /coffee, /coffee setup, /coffee status.\nCommands: /coffee [setup|status|name|room|config|on|off|logout|delete-account]',
    )
  })

  test('coffee while idle answers the idle rule even when removed', async () => {
    const { port, c } = await inBreak()
    port.emit({ type: 'kicked', reason: 'spam' })
    await tick()
    expect(await c.command('')).toBe(COPY.removed('spam'))
    c.turnComplete(false)
    expect(await c.command('')).toBe(COPY.idle)
  })
})
