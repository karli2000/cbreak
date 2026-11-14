// User-facing strings. Pure (runs in the mod environment).
import type { Role } from '../../shared/protocol.ts'
import type { Settings } from './settings.ts'

export const COPY = {
  idle: '☕ The cbreak room is only open while Claude is working.',
  opening: '☕ Opening the cbreak room…',
  joining: 'Joining the cbreak room…',
  notInRoom: "You're not in the cbreak room right now. /leave closes this pane.",
  off: 'cbreak is off. /cbreak on turns it back on.',
  on: 'cbreak is on.',
  title: (room: string, here: number) => `☕ ${room} · ${here} here`,
  status: (here: number) => `☕ ${here} on break`,
  statusHint: (here: number) => `☕ ${here} on break · /cbreak to join`,
  done: 'Claude is done, back to work ☕',
  busyAgain: 'Claude is busy again ☕',
  agentsBusy: "Claude's subagents are still working ☕",
  draftKept: 'Your unsent text is kept; it is back in the box at your next break.',
  draftBack: 'Your unsent text is back; press Enter to send it.',
  closingIn: (sec: number) => `closes in ${sec} s`,
  joined: (nick: string) => `${nick} joined the break`,
  left: (nick: string) => `${nick} went back to work`,
  moved: (room: string, instance: number) => `Moved to ${room} · ${instance}`,
  removed: (reason: string | null) => `You've been removed from cbreak: ${reason ?? 'no reason given'}`,
  full: 'The cbreak room is full, try again in a minute.',
  reconnecting: 'Connection lost, reconnecting…',
  reconnected: 'Reconnected.',
  helperGone: 'cbreak stopped unexpectedly. It will try again on your next task.',
  setupHint: '☕ Run /cbreak setup to chat with other people while Claude works.',
  signin: 'Sign in with GitHub to join cbreak. Press Enter to open GitHub.',
  loginUrl: (url: string) => `If the browser doesn't open, visit: ${url}`,
  pickNick: 'Pick a nickname (3–20 characters: a–z, 0–9, _ and -). Others only see this name.',
  available: (nick: string) => `✓ ${nick} is available`,
  taken: (nick: string) => `✗ ${nick} is taken`,
  rules:
    "Room rules: be kind · no spam · don't share private or company data · moderators can remove you. Privacy: https://github.com/karli2000/cbreak#privacy. Type yes to accept.",
  ready: (nick: string, min: number) =>
    `All set, ${nick}. The cbreak room opens by itself when Claude works for more than ${min} s. Open it any time with /cbreak while Claude is busy.`,
  deleteWarn: 'This deletes your cbreak profile. Run /cbreak delete-account yes to confirm.',
  reported: (nick: string) => `Reported ${nick}.`,
  muted: (nick: string, minutes: number) => `Muted ${nick} for ${minutes} min.`,
  banned: (nick: string) => `Banned ${nick}.`,
  // setup pane
  setupTitle: '☕ cbreak setup',
  setupOpening: '☕ Opening the cbreak setup…',
  setupRunning: '☕ Finish the setup in the cbreak pane first.',
  setupPlaceholder: { signin: 'press Enter to sign in', nick: 'nickname', rules: 'type yes to accept', done: 'press Enter to close' },
  setupGone: 'cbreak stopped unexpectedly. Run /cbreak setup to try again.',
  helperUnavailable: "Couldn't start cbreak. Try again in a moment.",
  needsBun: 'cbreak needs Bun. Install it with: curl -fsSL https://bun.sh/install | bash — then restart Claude Code.',
  signedInAs: (nick: string) => `You're signed in as ${nick}.`,
  // /cbreak subcommands
  statusSignedIn: (nick: string, role: Role) => `Signed in as ${nick} (${role})`,
  statusUnfinished: 'Signed in, setup not finished. Run /cbreak setup.',
  notSignedIn: 'Not signed in',
  settingsLine: (s: Settings) =>
    `Room: ${s.room} · min wait ${s.minBusySec} s · grace ${s.graceSec} s · auto-open ${s.autoOpen ? 'on' : 'off'} · emoji ${s.emoji ? 'on' : 'off'} · bg ${s.bg ?? 'default'} · text ${s.text ?? 'default'} · ${s.enabled ? 'enabled' : 'disabled'}`,
  onBreak: (yes: boolean) => `On break: ${yes ? 'yes' : 'no'}`,
  nameSet: (nick: string) => `Your nickname is now ${nick}.`,
  roomInvalid: 'Room names are 2–32 characters: a–z, 0–9 and -.',
  roomSet: (slug: string) => `Room set to ${slug}. It applies from your next break.`,
  saved: 'Saved.',
  saveFailed: "Couldn't save the setting.",
  signedOut: 'Signed out.',
  accountDeleted: 'Your cbreak profile was deleted.',
  commands: 'Commands: /cbreak [setup|status|name|room|config|on|off|logout|delete-account]',
  paneHelp: (mod: boolean) =>
    '/me <action> · /report <nick> <reason> · /leave · :) <3 :heart: → emoji · :hea then ↓ and Enter picks one' +
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
    case 'rules_not_accepted': return 'Accept the rules first. Run /cbreak setup.'
    case 'github_required': return 'cbreak needs a GitHub account. Sign in with GitHub.'
    case 'empty': return 'Say something first.'
    case 'limit_reached': return 'That limit is reached.'
    case 'not_signed_in': return 'Not signed in. Run /cbreak setup.'
    case 'network': return "Can't reach cbreak, retrying…"
    case 'realtime_unavailable': return COPY.full
    case 'login_failed': return 'GitHub sign-in failed. Run /cbreak setup to try again.'
    case 'no_bun': return COPY.needsBun
    default: return `Something went wrong (${code}).`
  }
}
