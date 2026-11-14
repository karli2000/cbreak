// Pure text helpers for the pane. Runs in the mod environment (no Node, no DOM).
import { nickLightness, toRgb } from './colors.ts'

/**
 * Stable per-nickname color: FNV-1a of the lowercased nick -> hue, saturation 65 %, lightness 55 %.
 * With the person's pane background (`bg`, a stored color), the lightness moves until the name
 * reads on it (`nickLightness`); the hue stays, so a name keeps its color family. The moderator site
 * calls it without `bg`.
 */
export function nickColor(nick: string, bg?: string | null): string {
  let h = 0x811c9dc5
  for (const ch of nick.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const rgb = bg ? toRgb(bg) : null
  return hslToHex(h % 360, 65, rgb ? nickLightness(h % 360, 65, rgb, hslToHex) : 55)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

export type Segment = { text: string; mention: boolean }

/** Split a body into plain and @mention segments for `myNick` (case-insensitive). */
export function segments(body: string, myNick: string | null): Segment[] {
  if (!myNick) return [{ text: body, mention: false }]
  const target = '@' + myNick.toLowerCase()
  const lower = body.toLowerCase()
  const out: Segment[] = []
  let last = 0
  let from = 0
  while (true) {
    const i = lower.indexOf(target, from)
    if (i < 0) break
    const end = i + target.length
    const before = i === 0 ? ' ' : body[i - 1]!
    const after = end >= body.length ? ' ' : body[end]!
    if (/\s/.test(before) && !/[a-z0-9_-]/i.test(after)) {
      if (i > last) out.push({ text: body.slice(last, i), mention: false })
      out.push({ text: body.slice(i, end), mention: true })
      last = end
    }
    from = i + 1
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false })
  return out.length ? out : [{ text: body, mention: false }]
}

export function isAction(body: string): boolean {
  return body.startsWith('/me ')
}

/** Line splitter for the helper's NDJSON stream: returns complete lines and the unfinished remainder. */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split('\n')
  const tail = parts.pop() ?? ''
  return { lines: parts.filter((l) => l.length > 0), rest: tail }
}
