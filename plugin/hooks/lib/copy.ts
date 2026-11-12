// User-facing strings. Pure (runs in the mod environment).
import type { Role } from '../../shared/protocol.ts'
import type { Settings } from './settings.ts'

export const COPY = {
  idle: '☕ The coffee room is only open while Claude is working.',
  opening: '☕ Opening the coffee room…',
  joining: 'Joining the coffee room…',
  notInRoom: "You're not in the coffee room right now. /leave closes this pane.",
  off: 'Coffee break is off. /coffee on turns it back on.',
  on: 'Coffee break is on.',
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
  reconnected: 'Reconnected.',
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
  reported: (nick: string) => `Reported ${nick}.`,
  muted: (nick: string, minutes: number) => `Muted ${nick} for ${minutes} min.`,
  banned: (nick: string) => `Banned ${nick}.`,
  // setup pane
  setupTitle: '☕ coffee break setup',
  setupOpening: '☕ Opening the coffee break setup…',
  setupRunning: '☕ Finish the setup in the coffee break pane first.',
  setupPlaceholder: { signin: 'press Enter to sign in', nick: 'nickname', rules: 'type yes to accept', done: 'press Enter to close' },
  setupGone: 'Coffee break stopped unexpectedly. Run /coffee setup to try again.',
  helperUnavailable: "Couldn't start coffee break. Try again in a moment.",
  needsBun: 'Coffee Break needs Bun. Install it with: curl -fsSL https://bun.sh/install | bash — then restart Claude Code.',
  notInvited:
    'Coffee Break is invite-only right now. Ask the person who invited you to add your GitHub account, then run /coffee setup again.',
  signedInAs: (nick: string) => `You're signed in as ${nick}.`,
  // /coffee subcommands
  statusSignedIn: (nick: string, role: Role) => `Signed in as ${nick} (${role})`,
  statusUnfinished: 'Signed in, setup not finished. Run /coffee setup.',
  notSignedIn: 'Not signed in',
  settingsLine: (s: Settings) =>
    `Room: ${s.room} · min wait ${s.minBusySec} s · grace ${s.graceSec} s · auto-open ${s.autoOpen ? 'on' : 'off'} · ${s.enabled ? 'enabled' : 'disabled'}`,
  onBreak: (yes: boolean) => `On break: ${yes ? 'yes' : 'no'}`,
  nameSet: (nick: string) => `Your nickname is now ${nick}.`,
  roomInvalid: 'Room names are 2–32 characters: a–z, 0–9 and -.',
  roomSet: (slug: string) => `Room set to ${slug}. It applies from your next break.`,
  saved: 'Saved.',
  saveFailed: "Couldn't save the setting.",
  signedOut: 'Signed out.',
  accountDeleted: 'Your coffee break profile was deleted.',
  commands: 'Commands: /coffee [setup|status|name|room|config|on|off|logout|delete-account]',
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
    case 'not_in_room': return "You're not in the room anymore."
    case 'not_signed_in': return 'Not signed in. Run /coffee setup.'
    case 'network': return "Can't reach coffee break, retrying…"
    case 'realtime_unavailable': return COPY.full
    case 'login_failed': return 'GitHub sign-in failed. Run /coffee setup to try again.'
    case 'no_bun': return COPY.needsBun
    case 'not_invited': return COPY.notInvited
    default: return `Something went wrong (${code}).`
  }
}
