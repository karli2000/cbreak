// Mod settings: types, defaults, validation. Pure (runs in the mod environment).
export type Settings = { room: string; minBusySec: number; graceSec: number; autoOpen: boolean; enabled: boolean }

export const DEFAULTS: Settings = { room: 'lobby', minBusySec: 20, graceSec: 15, autoOpen: true, enabled: true }

export type SettingKey = 'min-wait' | 'grace' | 'auto-open'

export type SettingResult = { ok: true; value: number | boolean } | { ok: false; error: string }

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
    case 'auto-open': {
      const t = raw.trim().toLowerCase()
      if (t === 'on' || t === 'true') return { ok: true, value: true }
      if (t === 'off' || t === 'false') return { ok: true, value: false }
      return { ok: false, error: 'auto-open must be on or off.' }
    }
    default:
      return { ok: false, error: 'Unknown setting.' }
  }
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
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
  }
}
