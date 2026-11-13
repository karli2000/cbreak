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
  reasonRequired: 'A reason is required.',
}

const TEXTS: Record<string, string> = {
  forbidden: "You can't act on someone with the same or a higher role.",
  not_found: 'Not found.',
  banned: COPY.banned,
  invalid_duration: 'Mute for 10, 60 or 1440 minutes.',
  invalid_pattern: 'That is not a valid pattern (at most 200 characters, no backreferences).',
  limit_reached: 'The word filter holds at most 100 patterns.',
  too_long: 'Too long (reasons up to 500 characters, titles up to 80).',
  empty: 'A title is required.',
  not_authenticated: 'Your session ended. Please sign in again.',
  network: "Can't reach the server. Check your connection.",
}

export function errorText(code: string): string {
  return TEXTS[code] ?? `Something went wrong (${code}).`
}
