import { describe, expect, test } from 'bun:test'
import { DEFAULTS, isRoomSlug, mergeStored, validateSetting } from '../../plugin/hooks/lib/settings.ts'

describe('validateSetting', () => {
  test('min-wait', () => {
    expect(validateSetting('min-wait', '0')).toEqual({ ok: true, value: 0 })
    expect(validateSetting('min-wait', '601').ok).toBe(false)
    expect(validateSetting('min-wait', 'abc').ok).toBe(false)
  })
  test('grace', () => {
    expect(validateSetting('grace', '300')).toEqual({ ok: true, value: 300 })
    expect(validateSetting('grace', '301').ok).toBe(false)
  })
  test('auto-open', () => {
    expect(validateSetting('auto-open', 'on')).toEqual({ ok: true, value: true })
    expect(validateSetting('auto-open', 'false')).toEqual({ ok: true, value: false })
    expect(validateSetting('auto-open', 'maybe').ok).toBe(false)
  })
  test('emoji', () => {
    expect(validateSetting('emoji', 'off')).toEqual({ ok: true, value: false })
    expect(validateSetting('emoji', 'on')).toEqual({ ok: true, value: true })
    expect(validateSetting('emoji', 'maybe')).toEqual({ ok: false, error: 'emoji must be on or off.' })
  })
})

test('isRoomSlug', () => {
  expect(isRoomSlug('lobby-de')).toBe(true)
  expect(isRoomSlug('Bad Slug')).toBe(false)
  expect(isRoomSlug('a')).toBe(false)
})

describe('mergeStored', () => {
  test('ignores bad fields', () => {
    expect(mergeStored({ graceSec: 'x', room: 'Bad Slug' })).toEqual(DEFAULTS)
    expect(mergeStored(null)).toEqual(DEFAULTS)
  })
  test('emoji defaults to on', () => {
    expect(DEFAULTS.emoji).toBe(true)
    expect(DEFAULTS.minBusySec).toBe(15)
    expect(DEFAULTS.graceSec).toBe(15)
    expect(mergeStored({}).emoji).toBe(true)
    expect(mergeStored({ emoji: false }).emoji).toBe(false)
    expect(mergeStored({ emoji: 'no' }).emoji).toBe(true)
  })
  test('keeps good fields', () => {
    expect(mergeStored({ graceSec: 5 }).graceSec).toBe(5)
    expect(mergeStored({ graceSec: 5000 }).graceSec).toBe(DEFAULTS.graceSec)
  })
})

describe('pane colors', () => {
  test('bg and text take names, hex and default', () => {
    expect(validateSetting('bg', '#2A1C15')).toEqual({ ok: true, value: '#2a1c15' })
    expect(validateSetting('text', 'White')).toEqual({ ok: true, value: 'white' })
    expect(validateSetting('bg', '#abc')).toEqual({ ok: true, value: '#aabbcc' })
    expect(validateSetting('bg', 'default')).toEqual({ ok: true, value: null })
    const bad = validateSetting('bg', 'purple')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('#2a1c15')
  })
  test('default to none; stored values are checked again', () => {
    expect(DEFAULTS.bg).toBeNull()
    expect(DEFAULTS.text).toBeNull()
    expect(mergeStored({ bg: '#2a1c15', text: 'white' })).toMatchObject({ bg: '#2a1c15', text: 'white' })
    expect(mergeStored({ bg: '#2A1C15', text: 'url(x)' })).toMatchObject({ bg: null, text: null })
    expect(mergeStored({ bg: 7 }).bg).toBeNull()
  })
})
