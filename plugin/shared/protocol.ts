// Wire protocol between the Claude Code mod and coffeebreakd.
// Imported by the mod too (no Node, no DOM): types and one constant only, no imports.
export const PROTOCOL_VERSION = 1

export type Role = 'user' | 'moderator' | 'admin'

export type AuthState =
  | { state: 'signed_out' }
  | { state: 'needs_nickname' }
  | { state: 'needs_rules'; nickname: string }
  | { state: 'banned'; nickname: string; ban_reason: string | null }
  | { state: 'ready'; nickname: string; role: Role; muted_until: string | null }

export type ChatMessage = {
  id: number
  user_id: string | null
  nickname: string
  body: string
  created_at: string
  role?: Role
}

export type JoinInfo = { room: string; instance: number; topic: string; here: number }

export type HelperEvent =
  | { type: 'hello'; protocol: 1; pid: number; socket: string }
  | ({ type: 'auth' } & AuthState)
  | { type: 'login'; url: string }
  | ({ type: 'joined' } & JoinInfo)
  | { type: 'backlog'; messages: ChatMessage[] }
  | ({ type: 'message' } & ChatMessage)
  | { type: 'deleted'; id: number }
  | { type: 'presence'; here: number; joined: string[]; left: string[] }
  | { type: 'kicked'; reason: string | null }
  | { type: 'room_closed' }
  /** The room could not be re-joined (e.g. `not_found`); the helper already dropped it. */
  | { type: 'room_lost'; code: string }
  | { type: 'connection'; state: 'online' | 'reconnecting' }
  | { type: 'error'; code: string; message?: string }

export type Api = {
  '/ping': { req: {}; res: {} }
  '/status': { req: {}; res: { auth: AuthState; room: JoinInfo | null } }
  '/login': { req: {}; res: { url: string } }
  '/logout': { req: {}; res: {} }
  '/delete-account': { req: {}; res: {} }
  '/nickname/check': { req: { nick: string }; res: { available: boolean } }
  '/nickname/claim': { req: { nick: string }; res: { nickname: string } }
  '/rules/accept': { req: {}; res: {} }
  /** `instance`: the instance to go back to (this Claude Code session's last one in that room). */
  '/join': { req: { room: string; instance?: number }; res: JoinInfo }
  '/leave': { req: {}; res: {} }
  '/send': { req: { body: string }; res: { id: number } }
  '/report': { req: { nickname: string; message_id: number | null; reason: string }; res: { report_id: number } }
  '/mod/delete': { req: { message_id: number; reason: string }; res: {} }
  '/mod/mute': { req: { nickname: string; minutes: 10 | 60 | 1440; reason: string }; res: {} }
  '/mod/ban': { req: { nickname: string; reason: string }; res: {} }
}

export type ApiPath = keyof Api

export type ApiResult<P extends ApiPath> =
  | { ok: true; data: Api[P]['res'] }
  | { ok: false; code: string; message?: string }
