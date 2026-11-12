// User-facing strings. Pure (runs in the mod environment).
export const COPY = {
  idle: '☕ The coffee room is only open while Claude is working.',
  title: (room: string, here: number) => `☕ ${room} · ${here} here`,
  status: (here: number) => `☕ ${here} on break`,
  statusHint: (here: number) => `☕ ${here} on break · /coffee to join`,
  done: 'Claude is done, back to work ☕',
  busyAgain: 'Claude is busy again ☕',
  draftKept: 'You have unsent text, staying until you send or clear it.',
  joined: (nick: string) => `${nick} joined the break`,
  left: (nick: string) => `${nick} went back to work`,
  moved: (room: string, instance: number) => `Moved to ${room} · ${instance}`,
  removed: (reason: string | null) => `You've been removed from coffee break: ${reason ?? 'no reason given'}`,
  full: 'The coffee room is full, try again in a minute.',
  reconnecting: 'Connection lost, reconnecting…',
  helperGone: 'Coffee break stopped unexpectedly. It will try again on your next task.',
  setupHint: '☕ Run /coffee setup to chat with other people while Claude works.',
  signin: 'Sign in with GitHub to join coffee break. Press Enter to open GitHub.',
  loginUrl: (url: string) => `If the browser doesn't open, visit: ${url}`,
  pickNick: 'Pick a nickname (3–20 characters: a–z, 0–9, _ and -). Others only see this name.',
  available: (nick: string) => `✓ ${nick} is available`,
  taken: (nick: string) => `✗ ${nick} is taken`,
  rules:
    "Room rules: be kind · no spam · don't share private or company data · moderators can remove you. Privacy: https://github.com/karli2000/coffeebreak#privacy. Type yes to accept.",
  ready: (nick: string, min: number) =>
    `All set, ${nick}. The coffee room opens by itself when Claude works for more than ${min} s. Open it any time with /coffee while Claude is busy.`,
  deleteWarn: 'This deletes your coffee break profile. Run /coffee delete-account yes to confirm.',
  paneHelp: (mod: boolean) =>
    '/me <action> · /report <nick> <reason> · /leave' +
    (mod ? ' · /del <nick> [reason] · /mute <nick> <10|60|1440> <reason> · /ban <nick> <reason>' : ''),
}

function hhmm(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function errorText(code: string, ctx?: { mutedUntil?: string | null }): string {
  switch (code) {
    case 'muted': {
      const t = ctx?.mutedUntil ? hhmm(ctx.mutedUntil) : null
      return t ? `You're muted until ${t}.` : "You're muted."
    }
    case 'rate_limited': return 'Slow down a little.'
    case 'duplicate': return 'You just said that.'
    case 'too_long': return 'Messages are at most 280 characters.'
    case 'filtered': return 'That message was blocked by the word filter.'
    case 'room_closed': return 'This room is closed.'
    case 'forbidden': return "You can't do that."
    case 'not_found': return 'Not found.'
    case 'already_reported': return 'You already reported them recently.'
    case 'cannot_report_self': return "You can't report yourself."
    case 'nickname_invalid': return '3–20 characters: a–z, 0–9, _ and -.'
    case 'nickname_reserved': return 'That name is reserved.'
    case 'nickname_taken': return 'That name is taken.'
    case 'nickname_change_too_soon': return 'You can change your name once every 30 days.'
    case 'not_signed_in': return 'Not signed in. Run /coffee setup.'
    case 'network': return "Can't reach coffee break, retrying…"
    case 'realtime_unavailable': return COPY.full
    case 'login_failed': return 'GitHub sign-in failed. Run /coffee setup to try again.'
    default: return `Something went wrong (${code}).`
  }
}
