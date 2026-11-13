// Turns chat shortcuts into emoji before a message is sent. Pure (runs in the mod environment).
// Shortcodes (`:heart:`) come from the generated gemoji table; emoticons (`:)`) from the fixed list below.
import { SHORTCODES } from './emoji-data.ts'

export const EMOTICONS: ReadonlyArray<readonly [typed: string, emoji: string]> = [
  [':)', '🙂'], [':-)', '🙂'], ['=)', '🙂'],
  [':(', '🙁'], [':-(', '🙁'],
  [':D', '😄'], [':-D', '😄'],
  ['xD', '😆'], ['XD', '😆'],
  [';)', '😉'], [';-)', '😉'],
  [':P', '😛'], [':-P', '😛'], [':p', '😛'], [':-p', '😛'],
  [';P', '😜'], [';p', '😜'],
  [':O', '😮'], [':-O', '😮'], [':o', '😮'], [':-o', '😮'],
  [":'(", '😢'],
  [':|', '😐'], [':-|', '😐'],
  [':/', '😕'], [':-/', '😕'],
  [':*', '😘'], [':-*', '😘'],
  ['>:(', '😠'],
  ['^_^', '😊'],
  ['-_-', '😑'],
  ['<3', '❤️'],
  ['</3', '💔'],
]

// A Map, so names like `constructor` or `__proto__` never hit inherited object keys.
const BY_NAME = new Map<string, string>(SHORTCODES)
const BY_TYPED = new Map<string, string>(EMOTICONS)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
// An emoticon counts only as a token on its own: start or whitespace before it, end, whitespace or . , ! ? after.
const EMOTICON_RE = new RegExp(
  `(^|\\s)(${[...BY_TYPED.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?=$|[\\s.,!?])`,
  'g',
)
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi

function shortcodes(s: string): string {
  let out = ''
  let i = 0
  for (;;) {
    SHORTCODE_RE.lastIndex = i
    const m = SHORTCODE_RE.exec(s)
    if (!m) break
    const end = m.index + m[0].length
    const emoji = BY_NAME.get(m[1]!.toLowerCase())
    if (emoji) {
      out += s.slice(i, m.index) + emoji
      i = end
    } else {
      // not a name: keep it and try again from its closing colon (`:nope:tada:` still converts `:tada:`)
      out += s.slice(i, end - 1)
      i = end - 1
    }
  }
  return out + s.slice(i)
}

function convert(s: string): string {
  return shortcodes(s).replace(EMOTICON_RE, (_, before: string, typed: string) => before + BY_TYPED.get(typed)!)
}

/** Converts emoticons and `:shortcodes:` to emoji. Text between a pair of backticks is left as typed. */
export function emojify(text: string): string {
  const parts = text.split('`')
  const last = parts.length - 1
  return parts
    .map((part, k) => {
      if (k % 2 === 1 && k < last) return part // inside a closed code span
      // a neighbouring backtick is not a boundary for an emoticon: convert with it attached, then drop it
      const pre = k > 0 ? '`' : ''
      const post = k < last ? '`' : ''
      const done = convert(pre + part + post)
      return done.slice(pre.length, done.length - post.length)
    })
    .join('`')
}
