// Pane colors (0.3.9, owner): the person's background and text color for the cbreak pane, and the
// contrast math that keeps nicknames readable on that background. Pure (runs in the mod environment).

/** The color names `/cbreak config bg|text` takes, with the RGB the contrast math assumes for them (xterm's). */
export const COLOR_NAMES: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  red: [205, 0, 0],
  green: [0, 205, 0],
  yellow: [205, 205, 0],
  blue: [0, 0, 238],
  magenta: [205, 0, 205],
  cyan: [0, 205, 205],
  white: [229, 229, 229],
  gray: [127, 127, 127],
}

/**
 * A color as typed (`#2a1c15`, `#abc`, `navy`…) to its stored form: a lowercase `#rrggbb` or one of
 * COLOR_NAMES (`grey` = `gray`); `default` = null (Claude Code's own look). undefined when invalid.
 */
export function normalizeColor(raw: string): string | null | undefined {
  const t = raw.trim().toLowerCase()
  if (t === 'default') return null
  if (t === 'grey') return 'gray'
  if (t in COLOR_NAMES) return t
  if (/^#[0-9a-f]{6}$/.test(t)) return t
  if (/^#[0-9a-f]{3}$/.test(t)) return '#' + [...t.slice(1)].map((c) => c + c).join('')
  return undefined
}

export function toRgb(color: string): [number, number, number] | null {
  const named = COLOR_NAMES[color]
  if (named) return [named[0], named[1], named[2]]
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** The text color for a background when the person chose none: near-black or near-white, whichever reads better. */
export function readableOn(bg: string): string {
  const rgb = toRgb(bg)
  if (!rgb) return '#f2f2f2'
  return contrast(rgb, [16, 16, 16]) >= contrast(rgb, [242, 242, 242]) ? '#101010' : '#f2f2f2'
}

/** The text color the pane draws with: the person's, else a readable one on their background, else none. */
export function effectiveText(bg: string | null, text: string | null): string | null {
  return text ?? (bg ? readableOn(bg) : null)
}

/** Contrast the nicknames aim for on a custom background (WCAG AA for normal text). */
export const NICK_CONTRAST = 4.5

/**
 * The lightness (HSL, percent) for a nickname of hue `h` on background `bg`: 55 (the default look)
 * when that already reads, else the nearest lightness away from the background that reaches
 * NICK_CONTRAST (lighter on a dark background, darker on a light one), at most 95 / at least 10.
 * The hue (who it is) never changes.
 */
export function nickLightness(h: number, s: number, bg: readonly [number, number, number], hsl: (h: number, s: number, l: number) => string): number {
  const ok = (l: number) => contrast(toRgb(hsl(h, s, l))!, bg) >= NICK_CONTRAST
  if (ok(55)) return 55
  const dark = luminance(bg) < 0.18
  for (let l = 55; dark ? l <= 95 : l >= 10; l += dark ? 5 : -5) if (ok(l)) return l
  return dark ? 95 : 10
}
