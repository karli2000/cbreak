// Mod settings: types, defaults, validation. Pure (runs in the mod environment).
import { normalizeColor } from './colors.ts'

/** `bg`/`text`: the pane's background and text color (a lowercase `#rrggbb` or a color name); null = Claude Code's own look. */
export type Settings = {
  room: string
  minBusySec: number
  graceSec: number
  autoOpen: boolean
  emoji: boolean
  enabled: boolean
  bg: string | null
  text: string | null
}

export const DEFAULTS: Settings = { room: 'lobby', minBusySec: 15, graceSec: 15, autoOpen: true, emoji: true, enabled: true, bg: null, text: null }

export type SettingKey = 'min-wait' | 'grace' | 'auto-open' | 'emoji' | 'bg' | 'text'

export type SettingValue = number | boolean | string | null

export type SettingResult = { ok: true; value: SettingValue } | { ok: false; error: string }

export const COLOR_HELP = 'a color name (black, red, green, yellow, blue, magenta, cyan, white, gray), a hex color such as #2a1c15, or default'

export function isRoomSlug(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9-]{2,32}$/.test(s)
}

function intInRange(raw: string, max: number, label: string): SettingResult {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return { ok: false, error: `${label} must be a whole number of seconds (0–${max}).` }
  const n = Number(t)
  if (n > max) return { ok: false, error: `${label} must be between 0 and ${max} seconds.` }
  return { ok: true, value: n }
}

export function validateSetting(key: SettingKey, raw: string): SettingResult {
  switch (key) {
    case 'min-wait':
      return intInRange(raw, 600, 'min-wait')
    case 'grace':
      return intInRange(raw, 300, 'grace')
    case 'auto-open':
    case 'emoji': {
      const t = raw.trim().toLowerCase()
      if (t === 'on' || t === 'true') return { ok: true, value: true }
      if (t === 'off' || t === 'false') return { ok: true, value: false }
      return { ok: false, error: `${key} must be on or off.` }
    }
    case 'bg':
    case 'text': {
      const c = normalizeColor(raw)
      return c === undefined ? { ok: false, error: `${key} must be ${COLOR_HELP}.` } : { ok: true, value: c }
    }
    default:
      return { ok: false, error: 'Unknown setting.' }
  }
}

/** A stored color: kept only when it is still a valid stored form. */
function color(v: unknown): string | null {
  return typeof v === 'string' && normalizeColor(v) === v ? v : null
}

function num(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null
}

export function mergeStored(v: unknown): Settings {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    room: isRoomSlug(o.room) ? o.room : DEFAULTS.room,
    minBusySec: num(o.minBusySec, 600) ?? DEFAULTS.minBusySec,
    graceSec: num(o.graceSec, 300) ?? DEFAULTS.graceSec,
    autoOpen: typeof o.autoOpen === 'boolean' ? o.autoOpen : DEFAULTS.autoOpen,
    emoji: typeof o.emoji === 'boolean' ? o.emoji : DEFAULTS.emoji,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
    bg: color(o.bg),
    text: color(o.text),
  }
}
