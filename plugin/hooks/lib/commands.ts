// Parsers for `/cbreak …` arguments and pane input. Pure (runs in the mod environment).
import { validateSetting } from './settings.ts'
import type { SettingKey } from './settings.ts'

export type CoffeeCommand =
  | { kind: 'open' } | { kind: 'setup' } | { kind: 'status' } | { kind: 'name'; nick: string } | { kind: 'room'; slug: string }
  | { kind: 'config' } | { kind: 'config_set'; key: SettingKey; value: number | boolean } | { kind: 'on' } | { kind: 'off' }
  | { kind: 'logout' } | { kind: 'delete_account'; confirmed: boolean } | { kind: 'invalid'; error: string }

export type PaneCommand =
  | { kind: 'say'; body: string } | { kind: 'me'; body: string } | { kind: 'leave' } | { kind: 'help' }
  | { kind: 'report'; nickname: string; reason: string } | { kind: 'del'; nickname: string; reason: string | null }
  | { kind: 'mute'; nickname: string; minutes: 10 | 60 | 1440; reason: string } | { kind: 'ban'; nickname: string; reason: string }
  | { kind: 'invalid'; error: string }

const SETTING_KEYS: readonly string[] = ['min-wait', 'grace', 'auto-open', 'emoji']

const nick = (s: string) => s.replace(/^@/, '').toLowerCase()

export function parseCoffeeArgs(args: string): CoffeeCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const [rawCmd, a, b] = parts
  const cmd = rawCmd?.toLowerCase()
  switch (cmd) {
    case undefined: return { kind: 'open' }
    case 'setup': return { kind: 'setup' }
    case 'status': return { kind: 'status' }
    case 'on': return { kind: 'on' }
    case 'off': return { kind: 'off' }
    case 'logout': return { kind: 'logout' }
    case 'name':
      return a ? { kind: 'name', nick: nick(a) } : { kind: 'invalid', error: 'Usage: /cbreak name <nickname>' }
    case 'room':
      // The slug itself is validated by the controller (its own message for a bad slug).
      return parts.length === 2 && a
        ? { kind: 'room', slug: a.toLowerCase() }
        : { kind: 'invalid', error: 'Usage: /cbreak room <name> (a–z, 0–9 and -, 2–32 characters)' }
    case 'config': {
      if (!a) return { kind: 'config' }
      if (!SETTING_KEYS.includes(a) || b === undefined) {
        return { kind: 'invalid', error: 'Usage: /cbreak config [min-wait <s> | grace <s> | auto-open on|off | emoji on|off]' }
      }
      const r = validateSetting(a as SettingKey, b)
      return r.ok ? { kind: 'config_set', key: a as SettingKey, value: r.value } : { kind: 'invalid', error: r.error }
    }
    case 'delete-account':
      return { kind: 'delete_account', confirmed: a === 'yes' }
    default:
      return { kind: 'invalid', error: `Unknown command "${cmd}". Try /cbreak, /cbreak setup, /cbreak status.` }
  }
}

function parseMinutes(s: string | undefined): 10 | 60 | 1440 | null {
  switch (s?.toLowerCase()) {
    case '10': case '10m': return 10
    case '60': case '60m': case '1h': return 60
    case '1440': case '24h': case '1d': return 1440
    default: return null
  }
}

export function parsePaneInput(text: string): PaneCommand {
  const t = text.trim()
  if (!t) return { kind: 'invalid', error: 'Nothing to send.' }
  if (t.startsWith('//')) return { kind: 'say', body: t.slice(1) }
  if (!t.startsWith('/')) return { kind: 'say', body: t }
  const m = /^\/(\S+)\s*(.*)$/s.exec(t)
  if (!m) return { kind: 'invalid', error: 'Type /help for commands.' }
  const cmd = m[1]!.toLowerCase()
  const rest = m[2]!
  const [who, ...more] = rest.split(/\s+/).filter(Boolean)
  switch (cmd) {
    case 'leave': return { kind: 'leave' }
    case 'help': return { kind: 'help' }
    case 'me':
      return rest ? { kind: 'me', body: rest } : { kind: 'invalid', error: 'Usage: /me <action>' }
    case 'report': {
      const reason = more.join(' ')
      return who && reason
        ? { kind: 'report', nickname: nick(who), reason }
        : { kind: 'invalid', error: 'Usage: /report <nick> <reason>' }
    }
    case 'del':
      return who
        ? { kind: 'del', nickname: nick(who), reason: more.length ? more.join(' ') : null }
        : { kind: 'invalid', error: 'Usage: /del <nick> [reason]' }
    case 'mute': {
      const minutes = parseMinutes(more[0])
      const reason = more.slice(1).join(' ')
      return who && minutes && reason
        ? { kind: 'mute', nickname: nick(who), minutes, reason }
        : { kind: 'invalid', error: 'Usage: /mute <nick> <10|60|1440> <reason>' }
    }
    case 'ban': {
      const reason = more.join(' ')
      return who && reason
        ? { kind: 'ban', nickname: nick(who), reason }
        : { kind: 'invalid', error: 'Usage: /ban <nick> <reason>' }
    }
    default:
      return { kind: 'invalid', error: `Unknown command /${cmd}. Type /help.` }
  }
}
