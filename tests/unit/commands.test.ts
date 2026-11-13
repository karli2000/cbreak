import { describe, expect, test } from 'bun:test'
import { parseCoffeeArgs, parsePaneInput } from '../../plugin/hooks/lib/commands.ts'
import { COPY, errorText } from '../../plugin/hooks/lib/copy.ts'

describe('parseCoffeeArgs', () => {
  test('basics', () => {
    expect(parseCoffeeArgs('')).toEqual({ kind: 'open' })
    expect(parseCoffeeArgs('setup')).toEqual({ kind: 'setup' })
    expect(parseCoffeeArgs('name Lena')).toEqual({ kind: 'name', nick: 'lena' })
    expect(parseCoffeeArgs('name @Lena')).toEqual({ kind: 'name', nick: 'lena' })
    expect(parseCoffeeArgs('room Lobby-DE')).toEqual({ kind: 'room', slug: 'lobby-de' })
    expect(parseCoffeeArgs('Setup')).toEqual({ kind: 'setup' })
    expect(parseCoffeeArgs('on')).toEqual({ kind: 'on' })
    expect(parseCoffeeArgs('off')).toEqual({ kind: 'off' })
    expect(parseCoffeeArgs('status')).toEqual({ kind: 'status' })
    expect(parseCoffeeArgs('logout')).toEqual({ kind: 'logout' })
  })
  test('config', () => {
    expect(parseCoffeeArgs('config')).toEqual({ kind: 'config' })
    expect(parseCoffeeArgs('config min-wait 30')).toEqual({ kind: 'config_set', key: 'min-wait', value: 30 })
    expect(parseCoffeeArgs('config grace 999').kind).toBe('invalid')
    expect(parseCoffeeArgs('config auto-open off')).toEqual({ kind: 'config_set', key: 'auto-open', value: false })
    expect(parseCoffeeArgs('config emoji off')).toEqual({ kind: 'config_set', key: 'emoji', value: false })
    expect(parseCoffeeArgs('config grace').kind).toBe('invalid')
    expect(parseCoffeeArgs('config nope 1').kind).toBe('invalid')
  })
  test('delete-account and invalid', () => {
    expect(parseCoffeeArgs('delete-account')).toEqual({ kind: 'delete_account', confirmed: false })
    expect(parseCoffeeArgs('delete-account yes')).toEqual({ kind: 'delete_account', confirmed: true })
    expect(parseCoffeeArgs('bogus').kind).toBe('invalid')
    expect(parseCoffeeArgs('name').kind).toBe('invalid')
    expect(parseCoffeeArgs('room Bad Slug').kind).toBe('invalid')
    expect(parseCoffeeArgs('room').kind).toBe('invalid')
    expect(parseCoffeeArgs('room x')).toEqual({ kind: 'room', slug: 'x' })
  })
})

describe('parsePaneInput', () => {
  test('say / me', () => {
    expect(parsePaneInput('hello')).toEqual({ kind: 'say', body: 'hello' })
    expect(parsePaneInput('//shrug')).toEqual({ kind: 'say', body: '/shrug' })
    expect(parsePaneInput('/me waves')).toEqual({ kind: 'me', body: 'waves' })
    expect(parsePaneInput('/me').kind).toBe('invalid')
  })
  test('report', () => {
    expect(parsePaneInput('/report @Ravi spamming links')).toEqual({ kind: 'report', nickname: 'ravi', reason: 'spamming links' })
    expect(parsePaneInput('/report ravi').kind).toBe('invalid')
  })
  test('mod commands', () => {
    expect(parsePaneInput('/mute ravi 1h too loud')).toEqual({ kind: 'mute', nickname: 'ravi', minutes: 60, reason: 'too loud' })
    expect(parsePaneInput('/mute ravi 10 x')).toMatchObject({ minutes: 10 })
    expect(parsePaneInput('/mute ravi 5 x').kind).toBe('invalid')
    expect(parsePaneInput('/del ravi')).toEqual({ kind: 'del', nickname: 'ravi', reason: null })
    expect(parsePaneInput('/del ravi rude')).toEqual({ kind: 'del', nickname: 'ravi', reason: 'rude' })
    expect(parsePaneInput('/ban ravi').kind).toBe('invalid')
    expect(parsePaneInput('/ban ravi spam')).toEqual({ kind: 'ban', nickname: 'ravi', reason: 'spam' })
  })
  test('misc', () => {
    expect(parsePaneInput('/leave')).toEqual({ kind: 'leave' })
    expect(parsePaneInput('/help')).toEqual({ kind: 'help' })
    expect(parsePaneInput('/xyz').kind).toBe('invalid')
    expect(parsePaneInput('/')).toEqual({ kind: 'invalid', error: 'Type /help for commands.' })
    expect(parsePaneInput('/ hi').kind).toBe('invalid')
  })
})

describe('copy', () => {
  test('errorText', () => {
    expect(errorText('muted')).toBe("You're muted.")
    expect(errorText('muted', { mutedUntil: null })).toBe("You're muted.")
    expect(errorText('muted', { mutedUntil: 'garbage' })).toBe("You're muted.")
    const iso = '2026-11-12T09:05:00Z'
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    expect(errorText('muted', { mutedUntil: iso })).toBe(`You're muted until ${hh}:${mm}.`)
    expect(errorText('realtime_unavailable')).toBe(COPY.full)
    expect(errorText('weird')).toBe('Something went wrong (weird).')
  })
  test('all codes', () => {
    const table: Record<string, string> = {
      rate_limited: 'Slow down a little.', duplicate: 'You just said that.',
      too_long: 'Messages are at most 280 characters.', filtered: 'That message was blocked by the word filter.',
      room_closed: 'This room is closed.', forbidden: "You can't do that.", not_found: 'Not found.',
      already_reported: 'You already reported them recently.', cannot_report_self: "You can't report yourself.",
      nickname_invalid: '3–20 characters: a–z, 0–9, _ and -.', nickname_reserved: 'That name is reserved.',
      nickname_taken: 'That name is taken.', nickname_change_too_soon: 'You can change your name once every 30 days.',
      not_signed_in: 'Not signed in. Run /cbreak setup.', network: "Can't reach cbreak, retrying…",
      login_failed: 'GitHub sign-in failed. Run /cbreak setup to try again.',
    }
    for (const [c, t] of Object.entries(table)) expect(errorText(c)).toBe(t)
  })
  test('placeholders', () => {
    expect(COPY.title('lobby', 3)).toBe('☕ lobby · 3 here')
    expect(COPY.removed(null)).toBe("You've been removed from cbreak: no reason given")
  })
})
