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
    expect(mergeStored({}).emoji).toBe(true)
    expect(mergeStored({ emoji: false }).emoji).toBe(false)
    expect(mergeStored({ emoji: 'no' }).emoji).toBe(true)
  })
  test('keeps good fields', () => {
    expect(mergeStored({ graceSec: 5 }).graceSec).toBe(5)
    expect(mergeStored({ graceSec: 5000 }).graceSec).toBe(DEFAULTS.graceSec)
  })
})
