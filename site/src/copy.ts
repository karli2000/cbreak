export const COPY = {
  notModerator: "You're not a moderator.",
  banned: 'Your account is banned.',
  signIn: 'Sign in with GitHub',
  signOut: 'Sign out',
  retry: 'Retry',
  expiredMessage: 'That message is already gone (messages expire after 15 minutes).',
  retention: 'Chat messages expire after 15 minutes; the snapshot is the record.',
  resolvedRetention: 'Resolved reports are kept 90 days.',
  adminIsFinal: "Admins can't be changed from this site afterwards.",
  invitesNote: "Invites decide who can create a Coffee Break profile. Removing an invite doesn't remove an existing profile.",
  inviteOffConfirm: 'Confirm: anyone with a GitHub account can join',
  reasonRequired: 'A reason is required.',
}

const TEXTS: Record<string, string> = {
  forbidden: "You can't act on someone with the same or a higher role.",
  not_found: 'Not found.',
  banned: COPY.banned,
  invalid_duration: 'Mute for 10, 60 or 1440 minutes.',
  invalid_pattern: 'That is not a valid pattern.',
  not_authenticated: 'Your session ended. Please sign in again.',
  github_not_found: 'No GitHub account with that name.',
  github_rate_limited: 'GitHub is rate-limiting lookups. Try again in a few minutes.',
  invalid_login: 'That is not a valid GitHub username.',
  not_invited: 'Not invited.',
  network: "Can't reach the server. Check your connection.",
}

export function errorText(code: string): string {
  return TEXTS[code] ?? `Something went wrong (${code}).`
}
