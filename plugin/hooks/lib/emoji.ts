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
// A shortcode needs a non-letter/digit (or the text's edge) on both sides, so `user:id:42` or `en:de:fr` stay as typed.
const SHORTCODE_RE = /(?<![A-Za-z0-9]):([a-z0-9_+-]+):(?![A-Za-z0-9])/gi

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
      // not a name: keep it and try again from its closing colon (`:nope: :tada:` still converts `:tada:`)
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

// ---- suggestions while typing (the pane's emoji box, spike S4) ----

/** One row of the pane's emoji box: taking it writes `emoji` in place of the typed `:token`. */
export type EmojiSuggestion = { name: string; emoji: string }

export const SUGGEST_LIMIT = 5
// The `:token` the draft ends with: at least two name characters, no letter or digit before the colon
// (as `emojify`'s shortcodes), so `user:id` or `en:de` offer nothing.
const TOKEN_RE = /(?<![A-Za-z0-9]):([a-z0-9_+-]{2,})$/i

/** Where the trailing `:token` starts and its name part (lowercased), or null. */
function trailingToken(draft: string): { start: number; query: string } | null {
  const m = TOKEN_RE.exec(draft)
  if (!m) return null
  // an odd number of backticks before it: typing inside a code span
  if ((draft.slice(0, m.index).match(/`/g)?.length ?? 0) % 2 === 1) return null
  return { start: m.index, query: m[1]!.toLowerCase() }
}

const byRank = (a: readonly [string, string], b: readonly [string, string]) =>
  a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

/**
 * The emoji box for a draft that ends in `:token`, best first: names that start with the token
 * (shortest first, then A-Z, as the prompt's own box), then names that contain it. One row per emoji.
 */
export function emojiSuggest(draft: string, limit = SUGGEST_LIMIT): EmojiSuggestion[] {
  const t = trailingToken(draft)
  if (!t) return []
  const prefix: (readonly [string, string])[] = []
  const inner: (readonly [string, string])[] = []
  for (const row of SHORTCODES) {
    if (row[0].startsWith(t.query)) prefix.push(row)
    else if (row[0].includes(t.query)) inner.push(row)
  }
  const out: EmojiSuggestion[] = []
  const seen = new Set<string>()
  for (const [name, emoji] of [...prefix.sort(byRank), ...inner.sort(byRank)]) {
    if (seen.has(emoji)) continue
    seen.add(emoji)
    out.push({ name, emoji })
    if (out.length === limit) break
  }
  return out
}

/** The draft with its trailing `:token` replaced by the emoji and a space; null when it no longer ends in one. */
export function applySuggestion(draft: string, s: EmojiSuggestion): string | null {
  const t = trailingToken(draft)
  return t ? draft.slice(0, t.start) + s.emoji + ' ' : null
}
