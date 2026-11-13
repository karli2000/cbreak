import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMOTICONS, SUGGEST_LIMIT, applySuggestion, emojiSuggest, emojify } from '../../plugin/hooks/lib/emoji.ts'
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
    expect(emojify('hi :tada:!')).toBe('hi 🎉!')
    expect(emojify('(:heart:)')).toBe('(❤️)')
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

  test('shortcodes inside words stay as typed', () => {
    for (const s of ['user:id:42', 'key cache:top:10', 'locales en:de:fr', 'HTTP:OK:200', 'a:link:hover', 'a:b:c:', 'tag v:new:', 'https://a.b/x:+1:', 'a:heart:b']) {
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

describe('emojiSuggest', () => {
  const names = (d: string) => emojiSuggest(d).map((s) => s.name)

  test('names that start with the token, shortest first, like the prompt box', () => {
    expect(names(':smi')).toEqual(['smile', 'smirk', 'smiley', 'smile_cat', 'smirk_cat'])
    expect(emojiSuggest('hi :smi')[0]).toEqual({ name: 'smile', emoji: '😄' })
    expect(names(':SMI')).toEqual(names(':smi'))
  })

  test('then names that contain it, one row per emoji, at most the limit', () => {
    const rows = emojiSuggest(':heart', 50)
    expect(rows[0]!.name).toBe('heart')
    expect(rows.some((r) => !r.name.startsWith('heart') && r.name.includes('heart'))).toBe(true)
    expect(new Set(rows.map((r) => r.emoji)).size).toBe(rows.length)
    expect(emojiSuggest(':a').length).toBe(0)
    expect(emojiSuggest(':sm').length).toBe(SUGGEST_LIMIT)
    expect(emojiSuggest(':sm', 2).length).toBe(2)
  })

  test('only for a :token at the end of the draft', () => {
    for (const d of ['', 'smi', ':s', ':smi ', ':smile:', 'user:smi', 'en:de', 'x :zzzzqq', '`code :smi', '``:smi` x'])
      expect(emojiSuggest(d)).toEqual([])
    expect(names('`a` :smi')[0]).toBe('smile')
    expect(names('(:smi')[0]).toBe('smile')
    expect(names(':+1')).toContain('+1')
  })
})

describe('applySuggestion', () => {
  test('replaces the trailing :token with the emoji and a space', () => {
    expect(applySuggestion('hi :smi', { name: 'smile', emoji: '😄' })).toBe('hi 😄 ')
    expect(applySuggestion(':ta', { name: 'tada', emoji: '🎉' })).toBe('🎉 ')
    expect(applySuggestion('hi :smi ', { name: 'smile', emoji: '😄' })).toBeNull()
  })
})
