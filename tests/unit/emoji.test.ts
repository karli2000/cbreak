import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMOTICONS, emojify } from '../../plugin/hooks/lib/emoji.ts'
import { SHORTCODES } from '../../plugin/hooks/lib/emoji-data.ts'
import { renderEmojiData } from '../../scripts/gen-emoji.ts'

const DATA_PATH = join(import.meta.dir, '../../plugin/hooks/lib/emoji-data.ts')
const cps = (s: string) => [...s].length

describe('emojify', () => {
  test('converts emoticons', () => {
    expect(emojify(':)')).toBe('🙂')
    expect(emojify('hi :) there')).toBe('hi 🙂 there')
    expect(emojify('<3')).toBe('❤️')
    expect(emojify('nice :D!')).toBe('nice 😄!')
    expect(emojify('>:( no')).toBe('😠 no')
    for (const [typed, emoji] of EMOTICONS) expect(emojify(typed)).toBe(emoji)
  })

  test('converts shortcodes', () => {
    expect(emojify(':heart:')).toBe('❤️')
    expect(emojify(':tada:')).toBe('🎉')
    expect(emojify(':+1:')).toBe('👍')
    expect(emojify(':thumbsup:')).toBe('👍')
    expect(emojify(':Heart:')).toBe('❤️')
    expect(emojify('a:heart:b')).toBe('a❤️b')
    expect(emojify(':heart::tada:')).toBe('❤️🎉')
  })

  test('ignores names that are not gemoji', () => {
    for (const s of [':nope:', ':constructor:', ':__proto__:', ':tostring:', '::']) expect(emojify(s)).toBe(s)
  })

  test('leaves urls, times and code alone', () => {
    for (const s of ['https://x.dev/a:b', 'at 12:30', 'std::vector', '(option B)', 'great:)', '`:) :heart:`', '`a:b:c:`']) {
      expect(emojify(s)).toBe(s)
    }
  })

  test('converts outside a code span', () => {
    expect(emojify('`x` :)')).toBe('`x` 🙂')
    expect(emojify('` :)')).toBe('` 🙂')
  })
})

describe('emoji table', () => {
  test('no replacement makes a body longer', () => {
    for (const [name, emoji] of SHORTCODES) expect(cps(emoji)).toBeLessThanOrEqual(name.length + 2)
    for (const [typed, emoji] of EMOTICONS) expect(cps(emoji)).toBeLessThanOrEqual(cps(typed))
  })

  test('table is fresh', () => {
    const fresh = renderEmojiData()
    const committed = readFileSync(DATA_PATH, 'utf8')
    if (fresh !== committed) throw new Error('emoji-data.ts is stale: run bun run emoji:gen')
  })

  test('table is complete', () => {
    const names = new Set(SHORTCODES.map(([n]) => n))
    for (const n of ['heart', '+1', '-1', '100', 'tada', 'coffee', 'de']) expect(names.has(n)).toBe(true)
    expect(names.size).toBeGreaterThan(1500)
  })
})
