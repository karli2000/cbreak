// Data layer: every function takes the supabase client first and throws ApiError.
// No React in here.
import type { SupabaseClient } from '@supabase/supabase-js'

export class ApiError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'ApiError'
    this.code = code
  }
}

export type Role = 'user' | 'moderator' | 'admin'
export type Me = { id: string; nickname: string; role: Role; banned: boolean }
export type SnapshotLine = { id: number; nickname: string; body: string; created_at: string; deleted?: true }
export type Report = {
  id: number
  reporter_id: string | null
  target_id: string | null
  message_id: number | null
  room: string | null
  instance: number | null
  reason: string
  snapshot: { message: SnapshotLine | null; context: SnapshotLine[] }
  status: 'open' | 'dismissed' | 'actioned'
  handled_by: string | null
  handled_at: string | null
  created_at: string
}
export type ModAction = {
  id: number
  actor_id: string | null
  target_id: string | null
  action: string
  reason: string | null
  details: Record<string, unknown>
  created_at: string
}
export type UserLookup = {
  profile: {
    id: string
    nickname: string
    role: Role
    github_created_at: string | null
    created_at: string
    muted_until: string | null
    banned_at: string | null
    ban_reason: string | null
  }
  reports_against: Omit<Report, 'target_id' | 'room' | 'instance'>[]
  actions_against: Omit<ModAction, 'target_id'>[]
}
export type ChatMessage = { id: number; user_id: string | null; nickname: string; body: string; created_at: string }
export type Room = { slug: string; title: string; kind: string; lang: string | null; is_open: boolean }

type PgError = { message?: string; status?: number; code?: string }

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  const err = (e ?? {}) as PgError
  const msg = typeof err.message === 'string' ? err.message : String(e)
  if (/^[a-z_]+$/.test(msg)) return new ApiError(msg)
  if (err.status === 401 || /jwt expired/i.test(msg)) return new ApiError('not_authenticated')
  if (
    err.status === 0 ||
    (e instanceof TypeError && /fetch|network|load failed/i.test(msg)) ||
    /fetch failed|failed to fetch|networkerror|network request failed|unable to connect|ECONNREFUSED|load failed/i.test(msg)
  ) {
    return new ApiError('network')
  }
  return new ApiError('unknown')
}

/** Awaits a supabase-js builder; throws ApiError on an error result or a thrown failure. */
async function run<T>(p: PromiseLike<{ data: T | null; error: PgError | null; status?: number }>): Promise<T> {
  let res
  try {
    res = await p
  } catch (e) {
    throw toApiError(e)
  }
  if (res.error) throw toApiError({ ...res.error, status: res.error.status ?? res.status })
  return res.data as T
}

export async function me(c: SupabaseClient): Promise<Me | null> {
  try {
    const p = await run<{ id: string; nickname: string; role: Role; banned_at: string | null }>(c.rpc('my_profile'))
    return { id: p.id, nickname: p.nickname, role: p.role, banned: p.banned_at !== null }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'no_profile') return null
    throw e
  }
}

export async function listReports(c: SupabaseClient, status: Report['status'], limit = 100): Promise<Report[]> {
  return run<Report[]>(
    c.from('reports').select('*').eq('status', status).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
  )
}

export async function resolveReport(c: SupabaseClient, id: number, status: 'dismissed' | 'actioned'): Promise<void> {
  await run(c.rpc('mod_resolve_report', { report_id: id, status }))
}

export async function deleteMessage(c: SupabaseClient, messageId: number, reason: string): Promise<void> {
  await run(c.rpc('mod_delete_message', { message_id: messageId, reason }))
}

export async function mute(c: SupabaseClient, userId: string, minutes: 10 | 60 | 1440, reason: string): Promise<void> {
  await run(c.rpc('mod_mute', { target: userId, minutes, reason }))
}

export async function unmute(c: SupabaseClient, userId: string, reason: string): Promise<void> {
  await run(c.rpc('mod_unmute', { target: userId, reason }))
}

export async function ban(c: SupabaseClient, userId: string, reason: string): Promise<void> {
  await run(c.rpc('mod_ban', { target: userId, reason }))
}

export async function unban(c: SupabaseClient, userId: string, reason: string): Promise<void> {
  await run(c.rpc('admin_unban', { target: userId, reason }))
}

export async function lookupUser(c: SupabaseClient, nickname: string): Promise<UserLookup> {
  return run<UserLookup>(c.rpc('mod_lookup_user', { nickname }))
}

export async function listBanned(
  c: SupabaseClient,
): Promise<{ id: string; nickname: string; banned_at: string; ban_reason: string | null }[]> {
  return (await run<{ id: string; nickname: string; banned_at: string; ban_reason: string | null }[]>(c.rpc('mod_list_banned'))) ?? []
}

export async function unbanGithubId(c: SupabaseClient, githubId: number, reason: string): Promise<void> {
  await run(c.rpc('admin_unban_github_id', { github_id: githubId, reason }))
}

export async function listActions(
  c: SupabaseClient,
  f: { action?: string; actorId?: string; targetId?: string; before?: { created_at: string; id: number } },
  limit = 50,
): Promise<ModAction[]> {
  let q = c.from('mod_actions').select('*')
  if (f.action) q = q.eq('action', f.action)
  if (f.actorId) q = q.eq('actor_id', f.actorId)
  if (f.targetId) q = q.eq('target_id', f.targetId)
  if (f.before) {
    // Keyset cursor: rows strictly older, or same timestamp with a smaller id.
    const ts = `"${f.before.created_at.replace(/["\\]/g, '')}"`
    q = q.or(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${Number(f.before.id)})`)
  }
  return run<ModAction[]>(q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit))
}

export async function names(c: SupabaseClient, ids: string[]): Promise<Map<string, { nickname: string; role: Role }>> {
  const out = new Map<string, { nickname: string; role: Role }>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return out
  const rows = await run<{ id: string; nickname: string; role: Role }[]>(
    c.from('public_profiles').select('id, nickname, role').in('id', unique),
  )
  for (const r of rows) out.set(r.id, { nickname: r.nickname, role: r.role })
  return out
}

export async function roomCounts(c: SupabaseClient): Promise<{ room: string; instance: number; here: number }[]> {
  return (await run<{ room: string; instance: number; here: number }[]>(c.rpc('room_counts'))) ?? []
}

export async function recentMessages(c: SupabaseClient, room: string, instance: number, limit = 100): Promise<ChatMessage[]> {
  const rows = await run<ChatMessage[]>(
    c
      .from('messages')
      .select('id, user_id, nickname, body, created_at')
      .eq('room', room)
      .eq('instance', instance)
      .order('id', { ascending: false })
      .limit(limit),
  )
  return rows.reverse()
}

/** Subscribes to a room's broadcasts without tracking presence (staff watch invisibly). */
export function watchRoom(
  c: SupabaseClient,
  room: string,
  instance: number,
  on: { message(m: ChatMessage): void; deleted(id: number): void; status(s: 'live' | 'error'): void },
): () => void {
  const channel = c
    .channel(`room:${room}:${instance}`, { config: { private: true } })
    .on('broadcast', { event: 'message' }, (m) => on.message(m.payload as ChatMessage))
    .on('broadcast', { event: 'deleted' }, (m) => on.deleted((m.payload as { id: number }).id))
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') on.status('live')
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') on.status('error')
    })
  return () => {
    void c.removeChannel(channel)
  }
}

export async function listRooms(c: SupabaseClient): Promise<Room[]> {
  return run<Room[]>(c.from('rooms').select('slug, title, kind, lang, is_open').order('slug'))
}

export async function upsertRoom(c: SupabaseClient, r: Room): Promise<void> {
  await run(c.rpc('admin_upsert_room', { slug: r.slug, title: r.title, kind: r.kind, lang: r.lang, is_open: r.is_open }))
}

export async function listFilters(c: SupabaseClient): Promise<{ id: number; pattern: string; created_at: string }[]> {
  return run(c.from('word_filter').select('id, pattern, created_at').order('id'))
}

export async function addFilter(c: SupabaseClient, pattern: string): Promise<number> {
  return Number(await run<number | string>(c.rpc('admin_add_filter', { pattern })))
}

export async function removeFilter(c: SupabaseClient, id: number): Promise<void> {
  await run(c.rpc('admin_remove_filter', { id }))
}

export async function listStaff(c: SupabaseClient): Promise<{ id: string; nickname: string; role: Role }[]> {
  return (await run<{ id: string; nickname: string; role: Role }[]>(c.rpc('admin_list_staff'))) ?? []
}

export async function setRole(c: SupabaseClient, userId: string, role: Role): Promise<void> {
  await run(c.rpc('admin_set_role', { target: userId, new_role: role }))
}

const fns = {
  me,
  listReports,
  resolveReport,
  deleteMessage,
  mute,
  unmute,
  ban,
  unban,
  lookupUser,
  listBanned,
  unbanGithubId,
  listActions,
  names,
  roomCounts,
  recentMessages,
  watchRoom,
  listRooms,
  upsertRoom,
  listFilters,
  addFilter,
  removeFilter,
  listStaff,
  setRole,
}

type WithoutClient<F> = F extends (c: SupabaseClient, ...a: infer A) => infer R ? (...a: A) => R : never

/** Every api function with the client pre-applied; screens receive this. */
export type Bound = { [K in keyof typeof fns]: WithoutClient<(typeof fns)[K]> }

export function bindApi(c: SupabaseClient): Bound {
  const out: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(fns)) {
    out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(c, ...args)
  }
  return out as Bound
}
