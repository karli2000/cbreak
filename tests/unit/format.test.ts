import { describe, expect, test } from 'bun:test'
import { isAction, nickColor, segments, splitLines } from '../../plugin/hooks/lib/format.ts'

describe('nickColor', () => {
  test('stable, case-insensitive', () => {
    expect(nickColor('lena')).toBe('#42d753')
    expect(nickColor('Lena')).toBe('#42d753')
    expect(nickColor('karli2000')).toBe('#42a5d7')
    expect(nickColor('ravi')).toBe('#d7425d')
  })
})

describe('segments', () => {
  test('mention', () => {
    expect(segments('hi @Lena!', 'lena')).toEqual([
      { text: 'hi ', mention: false },
      { text: '@Lena', mention: true },
      { text: '!', mention: false },
    ])
  })
  test('needs start or whitespace before @', () => {
    expect(segments('mail@lena.de', 'lena').some((s) => s.mention)).toBe(false)
  })
  test('next char must not continue a nick', () => {
    expect(segments('@lena_x', 'lena').some((s) => s.mention)).toBe(false)
  })
  test('no nick means no mentions', () => {
    expect(segments('@lena', null)).toEqual([{ text: '@lena', mention: false }])
  })
  test('mention at start', () => {
    expect(segments('@lena hi', 'lena')[0]).toEqual({ text: '@lena', mention: true })
  })
})

test('isAction', () => {
  expect(isAction('/me waves')).toBe(true)
  expect(isAction('/mexico')).toBe(false)
})

test('splitLines', () => {
  expect(splitLines('{"a"', ':1}\n{"b":2}\n{')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{' })
})
