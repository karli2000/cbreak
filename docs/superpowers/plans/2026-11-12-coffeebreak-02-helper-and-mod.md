# Coffee Break, Plan 2: Helper `coffeebreakd` + Claude Code mod

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Coffee Break Claude Code plugin. A mod notices when Claude is busy, joins a chat room after 20 s, shows the chat in a pane, and leaves after Claude is done. The helper `coffeebreakd` holds the login and the Realtime connection.

**Architecture:**
- **Helper** (`plugin/helper/`, Bun + supabase-js):
  - A process that lives for one break, setup or command.
  - Signs in with GitHub (PKCE, `127.0.0.1` callback) and keeps the session in `auth.json` (mode 600). Token refreshes are serialized across processes.
  - Joins the room, subscribes to its private Realtime topic, and writes one JSON event per line to stdout.
  - Serves the mod's requests as HTTP over a Unix socket. Tokens never reach the mod.
- **Mod** (`plugin/hooks/`, TypeScript):
  - A thin adapter (`register.ts`) maps Claude Code events and `$` calls onto a pure `Controller` that talks to the world only through a `Port` interface.
  - The Controller holds all lifecycle, chat, setup and command logic, and is unit-tested with a fake Port and a fake clock.
  - The pane is drawn from a plain `PaneView` value.

**Tech Stack:** Bun 1.4 (`bun test`, `Bun.serve({ unix })`, `Bun.spawn`), `@supabase/supabase-js` v2, Claude Code 2.1.322 mods (TypeScript hooks module, `claude plugin validate`, `claude plugin test`), local Supabase stack for integration tests.

**Spec:** `docs/superpowers/specs/2026-11-11-coffeebreak-design.md` (sections 4 and 5). **Also read:** `spikes/FINDINGS.md` (S1 and S3 verdicts), `CLAUDE.md` (backend rules and the "Client contract"), and the spike code `spikes/mod-pane/hooks/register.js` and `spikes/login/login.ts`. Both spikes worked, and Tasks 4 and 8 reuse their approach.

**Roadmap:**
- Plan 3: static moderator site.
- Plan 4: compiled helper binaries (`bun build --compile`), marketplace, README with the privacy statement, friends beta.

## Global Constraints

- **Mods API:** use only names that exist in the generated types for Claude Code 2.1.322 (`plugin/.claude-plugin/types/claude-code/index.d.ts`, written by the engine when it loads the plugin; git-ignored). Never trust this plan or memory over the types.
- **Mod environment:** no DOM, no Node, no `require`, no `import()`. Plugin files are imported with static `import`. Elements come from `$.ui.resolve(e)`. `$` is only passed into top-level functions (spike rule).
- **Privacy (anti-goal):** prompt text, tool calls, Claude's answers, file names and the cwd never leave the machine. The mod never forwards any field of `turn.*` or `prompt.*` events except `agentId` and `isAborted`. Only typed chat text, the room slug, nickname, reports and moderator commands go to the helper.
- **Focus:** the pane opens unfocused when the mod opens it on its own, and focused only when the user ran `/coffee …`. Never work around focus rules.
- **Owner rule:** the room can only be opened while Claude is busy. `/coffee` when idle answers exactly `☕ The coffee room is only open while Claude is working.` Setup and settings commands work at any time.
- **Owner rule:** the input line stays in view. After opening and after each own send, call `$.ui.scroll({ in: 'coffee', to: 'end' })`. `end` keeps following a growing tree until the user scrolls.
- **Owner rule:** nickname color = FNV-1a 32-bit of the lowercased nickname, then `hue = h % 360`, then `HSL(hue, 65%, 55%)` as `#rrggbb`. This is the spike's `nickColor`; `lena` → `#42d753`, `karli2000` → `#42a5d7`, `ravi` → `#d7425d`.
- **Timing defaults:** min busy before joining **20 s**, grace after Claude finishes **15 s**, heartbeat **30 s**, mod→helper ping **20 s**, helper idle exit **60 s** without any request, refresh margin **120 s** (hosted JWT expiry is 900 s).
- **Message cap in the pane:** 200 lines kept. Backlog on join: up to 100 newest live messages of the instance, oldest first.
- **Backend contract** (CLAUDE.md "Client contract"):
  - RPC errors are PostgREST 400 with `message = '<code>'`.
  - `heartbeat()` and `send_message` → `not_in_room` means re-`join_room` and switch topic.
  - `room_closed` means leave.
  - `kicked` payload `{id, user_id}`: act only if `user_id` is mine, then read `ban_reason` via `my_profile()`.
  - Call `github-age` once after the first `claim_nickname`.
- **Helper data dir:** `$COFFEEBREAK_DATA_DIR`, else `${XDG_CONFIG_HOME:-$HOME/.config}/coffeebreak`, mode 700. `auth.json` mode 600, written atomically.
  - Deviation from spec 5.1 (`CLAUDE_PLUGIN_DATA`): the mod API exposes no plugin data dir (`$.plugin` has only `name` and `root`).
  - Mod settings live in `$.store` instead of `config.json`.
- **Helper socket:** `${XDG_RUNTIME_DIR or os.tmpdir()}/coffeebreak-<uid>/<pid>.sock`, dir mode 700, removed on exit.
- **Helper env overrides:**
  - `COFFEEBREAK_SUPABASE_URL` and `COFFEEBREAK_SUPABASE_ANON_KEY` (default: the hosted project).
  - `COFFEEBREAK_DATA_DIR`.
  - Timing: `COFFEEBREAK_TICK_MS` (30000), `COFFEEBREAK_IDLE_EXIT_MS` (60000), `COFFEEBREAK_REFRESH_MARGIN_S` (120).
  - `COFFEEBREAK_NO_BROWSER=1` (tests).
- **Hosted backend constants:** URL `https://meioekkvutvrspfvqgye.supabase.co`, plus the project's public anon key. Get it with `bunx supabase projects api-keys --project-ref meioekkvutvrspfvqgye` (the `anon` row); it is public by design. Never embed the service-role or secret key.
- **Platforms:** Linux, macOS, WSL. Browser opening as in `spikes/login/login.ts`: WSL uses `powershell.exe Start-Process`, macOS `open`, Linux `xdg-open`.
- **Dev run:** `claude --plugin-dir plugin`. The mod starts the helper as `bun <root>/helper/main.ts` (Plan 4 swaps in `<root>/bin/coffeebreakd`).
- **Workflow:** test-first; keep `CLAUDE.md` current in every task; commits end with the `Co-Authored-By:` trailer; never push unless the owner asks; never run `bunx supabase config push`.

## Review Focus

1. **Two Claude sessions on a break at once, sharing one login.** Supabase rotates refresh tokens, so two helpers refreshing the same token can sign each other out. Expected: both stay signed in. One refreshes, the other adopts the file. → Task 1 test `two stores refreshing concurrently share one refresh`.
2. **The helper outlives Claude** (terminal closed, Ctrl+C twice, or a stop refused after Esc). Expected: the user leaves the room within about 60 s, and the helper process is gone. → Task 2 tests `exits and leaves after idle timeout` and `exits when its parent dies`.
3. **Laptop sleep or a Wi-Fi drop longer than 90 s mid-break.** Expected: the helper re-joins (perhaps another instance), the pane says so, and nothing crash-loops. → Task 3 test `re-joins after its occupancy row went stale`.
4. **Prompt text leaking into the chat path.** Expected: nothing typed to Claude ever reaches a spawn argv/env or a fetch body. → Task 8 test `prompt text never reaches spawn or fetch`.
5. **An unsent draft when Claude finishes, or Esc instead of a normal finish.** Expected: a draft keeps the room open until it is sent or cleared. After Esc, a refused close is retried on the next prompt. → Task 6 tests `draft holds the grace period` and `refused close is retried on next prompt`.

---

## File structure

```
plugin/
  .claude-plugin/plugin.json   name "coffeebreak", version "0.1.0", description, author
  hooks/hooks.json             { "modules": ["./register.ts"] }
  hooks/register.ts            event wiring + Port adapter over $ (Task 8)
  hooks/pane.ts                renderPane(view, els, handlers) (Task 8)
  hooks/lib/format.ts          nickColor, segments, isAction, splitLines (Task 5)
  hooks/lib/commands.ts        parseCoffeeArgs, parsePaneInput (Task 5)
  hooks/lib/copy.ts            every user-facing string, errorText(code) (Task 5)
  hooks/lib/settings.ts        Settings, DEFAULTS, validateSetting (Task 5)
  hooks/lib/controller.ts      Controller + Port + PaneView (Tasks 6, 7)
  shared/protocol.ts           helper events, API paths/requests/responses, AuthState (Task 1)
  shared/backend.ts            hosted URL + anon key defaults (Task 1)
  helper/main.ts               entry, lifecycle, signals, idle/parent watch (Task 2)
  helper/api.ts                Unix-socket routes (Tasks 2, 3, 4)
  helper/auth.ts               AuthStore, ensureFreshSession, authState (Task 1)
  helper/rpc.ts                CoffeeError, codeOf, rpc (Task 1)
  helper/emit.ts               createEmitter (Task 1)
  helper/room.ts               RoomSession, NicknameCache (Task 3)
  helper/login.ts              startLogin, browserCommand (Task 4)
  tests/*.test.ts              claude plugin test (Task 8)
tests/unit/*.test.ts           bun test, pure code (Tasks 1, 4, 5, 6, 7)
tests/integration/_helper.ts   startHelper() test driver (Task 2)
tests/integration/helper-*.test.ts   helper against the local stack (Tasks 1–4)
```

`package.json` scripts added in Task 1:
- `"test:unit": "bun test tests/unit"`
- `"test:mod": "claude plugin validate plugin && claude plugin test plugin"` (wired up in Task 8)
- `"dev": "claude --plugin-dir plugin"`

---

### Task 1: Shared protocol, RPC errors, emitter, auth store

**Files:**
- Create: `plugin/shared/protocol.ts`, `plugin/shared/backend.ts`, `plugin/helper/rpc.ts`, `plugin/helper/emit.ts`, `plugin/helper/auth.ts`
- Test: `tests/unit/rpc.test.ts`, `tests/unit/emit.test.ts`, `tests/unit/auth-store.test.ts`, `tests/integration/helper-auth.test.ts`
- Modify: `package.json` (scripts), `.gitignore` (add `plugin/.claude-plugin/types/`), `CLAUDE.md`

**Interfaces:**
- Produces, in `plugin/shared/protocol.ts` (types only, plus one constant; must import nothing, since the mod imports it too):
  ```ts
  export const PROTOCOL_VERSION = 1
  export type Role = 'user' | 'moderator' | 'admin'
  export type AuthState =
    | { state: 'signed_out' } | { state: 'needs_nickname' }
    | { state: 'needs_rules'; nickname: string }
    | { state: 'banned'; nickname: string; ban_reason: string | null }
    | { state: 'ready'; nickname: string; role: Role; muted_until: string | null }
  export type ChatMessage = { id: number; user_id: string | null; nickname: string; body: string; created_at: string; role?: Role }
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
    '/join': { req: { room: string }; res: JoinInfo }
    '/leave': { req: {}; res: {} }
    '/send': { req: { body: string }; res: { id: number } }
    '/report': { req: { nickname: string; message_id: number | null; reason: string }; res: { report_id: number } }
    '/mod/delete': { req: { message_id: number; reason: string }; res: {} }
    '/mod/mute': { req: { nickname: string; minutes: 10 | 60 | 1440; reason: string }; res: {} }
    '/mod/ban': { req: { nickname: string; reason: string }; res: {} }
  }
  export type ApiPath = keyof Api
  export type ApiResult<P extends ApiPath> = { ok: true; data: Api[P]['res'] } | { ok: false; code: string; message?: string }
  ```
- Produces, in `plugin/shared/backend.ts`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (hosted defaults).
- Produces, in `plugin/helper/rpc.ts`:
  - `class CoffeeError extends Error { code: string }`
  - `codeOf(err: unknown): string`
  - `rpc<T>(client: SupabaseClient, fn: string, args?: object): Promise<T>`, which throws `CoffeeError`
- Produces, in `plugin/helper/emit.ts`: `createEmitter(write: (s: string) => boolean | void, onBrokenPipe: () => void): (e: HelperEvent) => void`
- Produces, in `plugin/helper/auth.ts`:
  - `class AuthStore { constructor(dataDir: string); read(): Promise<Session | null>; write(s: Session): Promise<void>; clear(): Promise<void>; withLock<T>(fn: () => Promise<T>): Promise<T> }`
  - `ensureFreshSession(client: SupabaseClient, store: AuthStore, marginS: number): Promise<Session | null>`
  - `authState(client: SupabaseClient): Promise<AuthState>`
  - `createHelperClient(url: string, key: string): SupabaseClient`

**Rules for this task:**
- **`codeOf`:** a PostgREST/RPC error whose `message` matches `^[a-z_]+$` gives that message. A fetch/network failure (`TypeError`, or a message containing `fetch failed`/`ECONNREFUSED`) gives `network`. Anything else gives `unknown`.
- **`AuthStore`:**
  - Creates `dataDir` with mode 700.
  - File `auth.json` = `{ "version": 1, "session": Session }`, mode 600, written to `auth.json.tmp` then renamed.
  - `read()` returns null for a missing file, unparsable JSON or a wrong version.
  - `withLock` makes the directory `auth.lock` (atomic). It retries every 100 ms for up to 10 s, removes a lock older than 30 s, and always removes its own lock.
- **`ensureFreshSession`:**
  - If the client's current session expires more than `marginS` from now, return it unchanged.
  - Otherwise, inside `withLock`: re-read the file. If the file's session is still fresh, adopt it (`auth.setSession`) without refreshing.
  - Otherwise `auth.refreshSession({ refresh_token })` from the file's session (or the current one), write the result and return it.
  - On an invalid/revoked refresh token, `clear()` and return null.
  - In every case where the token changed, call `client.realtime.setAuth(access_token)`.
- **`createHelperClient`:** `auth: { flowType: 'pkce', autoRefreshToken: false, persistSession: true, storage: <in-memory Map> }`. The in-memory storage holds the PKCE verifier, exactly as in `spikes/login/login.ts`. The file is the only durable copy.
- **`authState`:**
  - No session → `signed_out`.
  - `my_profile` raising `no_profile` → `needs_nickname`.
  - `banned_at` set → `banned`.
  - `rules_accepted_at` null → `needs_rules`.
  - Otherwise `ready`.

- [ ] **Step 1: Write the failing unit tests**
  - `rpc.test.ts`:
    - `codeOf({ message: 'rate_limited', code: 'P0001' })` → `'rate_limited'`
    - `codeOf(new TypeError('fetch failed'))` → `'network'`
    - `codeOf({ message: 'duplicate key value violates…' })` → `'unknown'`
  - `emit.test.ts`:
    - Emitting `{type:'deleted',id:7}` writes exactly `{"type":"deleted","id":7}\n`.
    - A `write` that throws `{ code: 'EPIPE' }` calls `onBrokenPipe` once and does not throw.
  - `auth-store.test.ts` (temp dir):
    - `write` then `read` round-trips.
    - File mode is `0o600` and dir mode is `0o700`.
    - `read` of garbage returns null; `clear` removes the file.
    - Two concurrent `withLock` bodies never overlap: record enter/exit order and expect `[in,out,in,out]`.
    - A stale `auth.lock` (mtime 31 s ago, set with `utimes`) is taken over.
- [ ] **Step 2:** Run `bun test tests/unit` and confirm FAIL (modules missing).
- [ ] **Step 3:** Implement `protocol.ts`, `backend.ts`, `rpc.ts`, `emit.ts`, and the `AuthStore` part of `auth.ts`.
- [ ] **Step 4:** Run `bun test tests/unit` and confirm PASS.
- [ ] **Step 5: Write the failing integration test** `tests/integration/helper-auth.test.ts` (local stack, uses `_env.ts`):
  - `authState reports ready for a set-up user`: `userClient('ha')` → `{ state: 'ready', nickname: 'ha_<runId>', role: 'user' }`.
  - `authState reports needs_nickname without a profile`: add `bareUser()` to `_env.ts`. It is an email user signed in without `claim_nickname`, tracked for cleanup.
  - `two stores refreshing concurrently share one refresh`:
    - Write a user's session to a temp data dir.
    - Create two clients via `createHelperClient`, each `setSession` from the file.
    - Call `ensureFreshSession(client, new AuthStore(dir), 10_000)` on both in parallel. A margin above the token lifetime forces the refresh path.
    - Expect both results non-null, with **equal** `refresh_token`s that differ from the original.
    - Expect `my_profile` to succeed on both clients.
- [ ] **Step 6:** Run `bun test tests/integration/helper-auth.test.ts` and confirm FAIL. Implement `ensureFreshSession`, `authState` and `createHelperClient`. Re-run and confirm PASS.
- [ ] **Step 7:** Add the scripts and the `.gitignore` line. Add a "Plugin" section to `CLAUDE.md` covering the layout, data dir, env overrides and the `bun run test:unit` command. Commit `feat(helper): protocol, rpc errors, emitter, auth store`.

### Task 2: Helper process, socket API, lifecycle

**Files:**
- Create: `plugin/helper/main.ts`, `plugin/helper/api.ts`, `tests/integration/_helper.ts`, `tests/integration/helper-process.test.ts`
- Modify: `tests/integration/_env.ts` (if needed), `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces, in `plugin/helper/api.ts`: `type Ctx = { client: SupabaseClient; store: AuthStore; emit: Emit; room: { leave(): Promise<void> } | null; touch(): void }` (Task 3 widens `room` to `RoomSession | null`) and `routes: { [P in ApiPath]?: (ctx: Ctx, req: Api[P]['req']) => Promise<Api[P]['res']> }`. Tasks 3 and 4 add their paths to `routes`.
- Produces, in `plugin/helper/main.ts`: `bun plugin/helper/main.ts` runs the helper.
  - On start it emits `hello`, then one `auth` event.
  - Every request returns HTTP 200 with an `ApiResult` JSON body. An unknown path is 404 and invalid JSON is 400 `{ok:false, code:'bad_request'}`.
  - Every request calls `touch()`, which resets the idle timer.
- Produces, in `tests/integration/_helper.ts`:
  ```ts
  startHelper(opts: { session?: Session; env?: Record<string,string> }): Promise<{
    proc: Subprocess; dataDir: string; socket: string; events: HelperEvent[]
    waitFor<T extends HelperEvent['type']>(type: T, pred?: (e) => boolean, timeoutMs?: number): Promise<Extract<HelperEvent,{type:T}>>
    call<P extends ApiPath>(path: P, body?: Api[P]['req']): Promise<ApiResult<P>>   // fetch('http://localhost'+path, { unix: socket, method: 'POST', ... })
    stop(): Promise<number | null> }>
  ```
  It runs `bun plugin/helper/main.ts` with `COFFEEBREAK_SUPABASE_URL`/`ANON_KEY` taken from `env()`, a fresh temp `COFFEEBREAK_DATA_DIR` (pre-filled with `auth.json` when a `session` is given) and `COFFEEBREAK_NO_BROWSER=1`. It resolves after `hello`.

**Behavior:**
- **Session at start:**
  - Read `auth.json`. If a session is present, `setSession` and then `ensureFreshSession`.
  - If the profile is `ready` and `github_created_at` is null, invoke `github-age` once. Errors are ignored; email test users get 400.
- **Tick loop:** every `COFFEEBREAK_TICK_MS`, run `ensureFreshSession`; a null result emits `auth signed_out`. Task 3 adds the room heartbeat to the same tick.
- **Shutdown triggers:**
  - No request for `COFFEEBREAK_IDLE_EXIT_MS` → shut down with reason `idle`.
  - `process.ppid` changed (checked every 1 s) → shut down with reason `orphaned`.
  - SIGTERM, SIGINT or SIGHUP → shut down.
  - Shutdown calls `leave_room` whenever a session exists (idempotent, 3 s cap), stops the server, removes the socket file and exits 0.
- **Routes:**
  - `/ping` → `{}`.
  - `/status` → `{ auth, room }`.
  - Every other route without a session → `{ok:false, code:'not_signed_in'}`.
  - `/nickname/check` → `nickname_available`.
  - `/nickname/claim` → `claim_nickname`. If `github_created_at` is null, then `github-age` (errors ignored). Emits `auth` and returns `{ nickname }`.
  - `/rules/accept` → `accept_rules`, emits `auth`.
  - `/logout` → leave if joined, `auth.signOut({ scope: 'local' })`, `store.clear()`, emits `auth signed_out`.
  - `/delete-account` → leave if joined, `delete_my_account`, `store.clear()`, emits `auth signed_out`.

- [ ] **Step 1: Write the failing tests** in `helper-process.test.ts`:
  - `says hello and reports auth`:
    - With a ready user's session: `hello.socket` exists, and the next event is `{type:'auth', state:'ready'}`.
    - Without a session: `state:'signed_out'`.
  - `rejects calls when signed out`: `call('/nickname/check', {nick:'abc'})` → `{ok:false, code:'not_signed_in'}`.
  - `unknown path is 404`.
  - `claims a nickname and accepts rules`:
    - Start with a `bareUser()` session → `needs_nickname`.
    - `/nickname/check {nick:'hp_<runId>'}` → `available: true`.
    - `/nickname/claim` → `auth needs_rules`; `/rules/accept` → `auth ready`.
  - `maps RPC errors to codes`: `/nickname/claim {nick:'admin'}` → `code:'nickname_reserved'`.
  - `writes auth.json with mode 600`.
  - `exits and leaves after idle timeout`:
    - Start with `COFFEEBREAK_IDLE_EXIT_MS=1500`.
    - Join `testRoom` with the service role, by inserting an occupancy row for the user. Task 3 replaces this with `/join`.
    - Expect the process to exit with code 0 within 5 s, and the user's occupancy row to be gone.
  - `exits when its parent dies`:
    - Start the helper through `sh -c 'bun plugin/helper/main.ts & echo $!; wait'` and kill the `sh`.
    - Expect the helper pid gone within 5 s (`process.kill(pid, 0)` throws).
  - `SIGTERM exits 0 and removes the socket`.
- [ ] **Step 2:** Run `bun test tests/integration/helper-process.test.ts` and confirm FAIL.
- [ ] **Step 3:** Implement `api.ts` (server via `Bun.serve({ unix: socketPath, fetch })`, routes above) and `main.ts` (env parsing, data dir, client, AuthStore, emitter on stdout, tick, idle/parent watch, signals).
- [ ] **Step 4:** Run the test file and confirm PASS. Then run `bun run test:int` and confirm all earlier integration tests still pass.
- [ ] **Step 5:** Document the routes, env and lifecycle in `CLAUDE.md`. Commit `feat(helper): process, socket API, lifecycle`.

### Task 3: Helper room session

**Files:**
- Create: `plugin/helper/room.ts`, `tests/integration/helper-room.test.ts`
- Modify: `plugin/helper/api.ts`, `plugin/helper/main.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `rpc`, `CoffeeError`, `HelperEvent`, `JoinInfo`, `ChatMessage`, `Ctx`/`routes` from Tasks 1–2.
- Produces:
  ```ts
  class NicknameCache { constructor(client); names(ids: string[]): Promise<Map<string, { nickname: string; role: Role }>>; idOf(nickname: string): Promise<string> /* throws CoffeeError('not_found') */ }
  class RoomSession {
    constructor(deps: { client: SupabaseClient; emit: (e: HelperEvent) => void; userId: string; cache: NicknameCache })
    join(room: string): Promise<JoinInfo>; heartbeat(): Promise<void>; leave(): Promise<void>
    send(body: string): Promise<{ id: number }>
    report(nickname: string, messageId: number | null, reason: string): Promise<{ report_id: number }>
    modDelete(messageId: number, reason: string): Promise<void>
    modMute(nickname: string, minutes: 10 | 60 | 1440, reason: string): Promise<void>
    modBan(nickname: string, reason: string): Promise<void>
    current(): JoinInfo | null }
  ```
  - Routes added: `/join`, `/leave`, `/send`, `/report`, `/mod/delete`, `/mod/mute`, `/mod/ban`.
  - The main tick calls `room?.heartbeat()` after `ensureFreshSession`.

**Behavior:**
- **`join(room)`:**
  1. `join_room(room_slug)`.
  2. Remove any old channel. Then `client.channel(topic, { config: { private: true, presence: { key: userId } } })`.
  3. Handlers: broadcast `message` → emit `message`; `deleted` → emit `deleted {id}`; `kicked` → only if `payload.user_id === userId`.
  4. Presence `join`/`leave` → emit `presence { here: keys(presenceState()).length, joined/left: nicknames via cache, self excluded }`.
  5. Subscribe, then `track({})`.
  6. Load the backlog: `messages` filtered by room/instance, `deleted_at is null`, newest 100, reversed. Roles come from the cache. Emit `joined`, then `backlog`.
- **`kicked` for me:** `my_profile()`, then emit `kicked { reason: ban_reason }`. Remove the channel and drop the room. The process stays up for the mod to stop.
- **Subscribe failure** (`CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED` while joined):
  - Emit `connection reconnecting`, call `heartbeat()`, then re-subscribe with backoff 1, 2, 4, 8, 16, 30, 30… s.
  - After the 3rd consecutive failure, emit `error {code:'realtime_unavailable'}`; the mod shows "room full" copy. Keep retrying.
  - On success, emit `connection online`.
- **`heartbeat()`:**
  - `not_in_room` → `join(sameRoom)`, which re-emits `joined` + `backlog`.
  - `room_closed` → emit `room_closed`, then `leave()`.
  - `banned` → handled like kicked.
- **`send(body)`:** `not_in_room` → `join(sameRoom)` and retry once. Other codes propagate as `CoffeeError`.
- **Moderator calls:** `modMute`/`modBan` resolve the nickname with `cache.idOf`. `public_profiles` `nickname` is citext, so `eq` is case-insensitive.
- **`leave()`:** `leave_room` (errors ignored), remove the channel, clear `current`.

- [ ] **Step 1: Write the failing tests** in `helper-room.test.ts`. Users come from `userClient`; their sessions are passed to `startHelper`; all joins use `testRoom`.
  - `join emits joined then backlog with earlier messages`:
    - User B (a plain supabase-js client) joins `testRoom` and sends "earlier".
    - Helper A `/join {room: testRoom}` → `joined.topic === 'room:'+testRoom+':1'`.
    - The `backlog` messages include body "earlier".
  - `relays messages both ways`:
    - A `/send {body:'hi from A'}` → `{ok:true}`.
    - B's channel receives it, and A's helper emits `message` with `nickname` = A's nickname.
    - B sends; A emits `message`.
  - `relays deletions`: a moderator user calls `mod_delete_message` on B's message → A emits `deleted {id}`.
  - `presence reports joins with nicknames`: B subscribes and tracks → A emits `presence` with `joined` containing B's nickname and `here >= 2`.
  - `re-joins after its occupancy row went stale`:
    - Set A's `occupancy.last_seen = now() - interval '2 minutes'` with the service role.
    - Start with `COFFEEBREAK_TICK_MS=1000`.
    - Expect a second `joined` event within 5 s.
    - Expect `/send` to work afterwards.
  - `kicked only acts for me`:
    - A moderator bans B → A emits no `kicked`.
    - A moderator bans A → A emits `kicked {reason}` with the ban reason.
  - `room_closed is reported`: the service role sets `rooms.is_open=false` for `testRoom`; with `TICK_MS=1000`, A emits `room_closed`. Reopen the room afterwards.
  - `send maps errors`:
    - The first send works.
    - An immediate second send → `code:'rate_limited'`.
    - A 281-char body → `code:'too_long'`.
  - `report resolves the target and message`: A `/report {nickname: B, message_id: <B's msg>, reason:'spam'}` → `ok`, a positive `report_id`.
  - `moderator commands resolve nicknames`:
    - The moderator helper `/mod/mute {nickname: B, minutes: 10, reason:'x'}` → `ok`, and B's `muted_until` is set.
    - An unknown nickname → `not_found`.
  - `leave removes occupancy`: `/leave` → no occupancy row for A.
- [ ] **Step 2:** Run `bun test tests/integration/helper-room.test.ts` and confirm FAIL.
- [ ] **Step 3:** Implement `room.ts` and the routes. Also wire the heartbeat into the tick, and add leave-on-shutdown (replacing Task 2's test shim: switch that test to `/join`).
- [ ] **Step 4:** Run the room tests, then `bun run test:int`, and confirm all pass.
- [ ] **Step 5:** Update `CLAUDE.md` (room session behavior, events). Commit `feat(helper): room session, chat relay, moderation calls`.

### Task 4: Helper login (PKCE)

**Files:**
- Create: `plugin/helper/login.ts`, `tests/unit/login.test.ts`, `tests/integration/helper-login.test.ts`
- Modify: `plugin/helper/api.ts`, `CLAUDE.md`

**Interfaces:**
- Produces:
  - `browserCommand(url: string, platform: NodeJS.Platform, isWsl: boolean): [string, string[]]`
  - `startLogin(client: SupabaseClient, opts: { open: (url: string) => void; timeoutMs: number }): Promise<{ url: string; done: Promise<Session> }>`
  - Route `/login`: returns `{ url }` at once and emits `login {url}`.
    - When `done` resolves: `store.write`, `setSession`, emit `auth` (the new state).
    - On failure or a 5-minute timeout: emit `error {code:'login_failed', message}`.
    - A second `/login` while one is pending returns the same URL.
- Approach: `spikes/login/login.ts`. A `Bun.serve` on `127.0.0.1:0` serves `/callback`, then `signInWithOAuth({ provider: 'github', options: { redirectTo, skipBrowserRedirect: true } })`, then `exchangeCodeForSession(code)`.
- The callback page HTML-escapes the error text. Success copy: `☕ Signed in to Coffee Break. You can close this tab.` Failure copy: `Login failed: <escaped text>`.
- With `COFFEEBREAK_NO_BROWSER=1`, `open` is a no-op. Detect WSL via `/proc/version` containing `microsoft` (case-insensitive).

- [ ] **Step 1: Write the failing tests**
  - Unit `browserCommand`:
    - WSL → `['powershell.exe', ['-NoProfile','-Command',"Start-Process 'https://x/?a=1'"]]`, and a `'` inside the URL is doubled.
    - darwin → `['open', [url]]`; linux → `['xdg-open', [url]]`.
  - Integration `login URL targets GitHub with a localhost callback`:
    - Start a signed-out helper and call `/login`.
    - The URL path is `/auth/v1/authorize`, with `provider=github` and `code_challenge_method=s256` (case-insensitive).
    - `redirect_to` matches `^http://127\.0\.0\.1:\d+/callback$`.
    - A `login` event carries the same URL.
  - Integration `callback error is escaped and reported`:
    - GET `redirect_to + '?error=access_denied&error_description=<b>x</b>'`.
    - The body contains `&lt;b&gt;x&lt;/b&gt;` and no `<b>`.
    - The helper emits `error {code:'login_failed'}`.
- [ ] **Step 2:** Run both test files and confirm FAIL.
- [ ] **Step 3:** Implement `login.ts` and the route.
- [ ] **Step 4:** Run the tests and confirm PASS. The real GitHub round-trip is checked by the owner in Task 8.
- [ ] **Step 5:** Commit `feat(helper): GitHub PKCE login`.

### Task 5: Mod pure library (format, commands, copy, settings)

**Files:**
- Create: `plugin/hooks/lib/format.ts`, `plugin/hooks/lib/commands.ts`, `plugin/hooks/lib/copy.ts`, `plugin/hooks/lib/settings.ts`
- Test: `tests/unit/format.test.ts`, `tests/unit/commands.test.ts`, `tests/unit/settings.test.ts`

**Interfaces** (no imports except `../../shared/protocol.ts` types; these files run in the mod environment):
- In `format.ts`:
  - `nickColor(nick: string): string`
  - `type Segment = { text: string; mention: boolean }`
  - `segments(body: string, myNick: string | null): Segment[]`
  - `isAction(body: string): boolean` (body starts with `/me `)
  - `splitLines(rest: string, chunk: string): { lines: string[]; rest: string }`
- In `commands.ts`:
  ```ts
  type CoffeeCommand = { kind: 'open' } | { kind: 'setup' } | { kind: 'status' } | { kind: 'name'; nick: string } | { kind: 'room'; slug: string }
    | { kind: 'config' } | { kind: 'config_set'; key: SettingKey; value: number | boolean } | { kind: 'on' } | { kind: 'off' }
    | { kind: 'logout' } | { kind: 'delete_account'; confirmed: boolean } | { kind: 'invalid'; error: string }
  type PaneCommand = { kind: 'say'; body: string } | { kind: 'me'; body: string } | { kind: 'leave' } | { kind: 'help' }
    | { kind: 'report'; nickname: string; reason: string } | { kind: 'del'; nickname: string; reason: string | null }
    | { kind: 'mute'; nickname: string; minutes: 10 | 60 | 1440; reason: string } | { kind: 'ban'; nickname: string; reason: string }
    | { kind: 'invalid'; error: string }
  parseCoffeeArgs(args: string): CoffeeCommand
  parsePaneInput(text: string): PaneCommand
  ```
- In `settings.ts`:
  - `type Settings = { room: string; minBusySec: number; graceSec: number; autoOpen: boolean; enabled: boolean }`
  - `DEFAULTS = { room: 'lobby', minBusySec: 20, graceSec: 15, autoOpen: true, enabled: true }`
  - `type SettingKey = 'min-wait' | 'grace' | 'auto-open'`
  - `validateSetting(key, raw: string): { ok: true; value } | { ok: false; error: string }`
  - `isRoomSlug(s): boolean` (`^[a-z0-9-]{2,32}$`)
  - `mergeStored(v: unknown): Settings` (ignores bad fields)
- In `copy.ts`: the `COPY` object of exact strings, and `errorText(code: string, ctx?: { mutedUntil?: string | null }): string`.

**Exact copy** (`COPY`):

| key | text |
|---|---|
| idle | `☕ The coffee room is only open while Claude is working.` |
| title | `☕ ${room} · ${here} here` |
| status | `☕ ${here} on break` |
| statusHint | `☕ ${here} on break · /coffee to join` |
| done | `Claude is done, back to work ☕` |
| busyAgain | `Claude is busy again ☕` |
| draftKept | `You have unsent text, staying until you send or clear it.` |
| joined | `${nick} joined the break` |
| left | `${nick} went back to work` |
| moved | `Moved to ${room} · ${instance}` |
| removed | `You've been removed from coffee break: ${reason ?? 'no reason given'}` |
| full | `The coffee room is full, try again in a minute.` |
| reconnecting | `Connection lost, reconnecting…` |
| helperGone | `Coffee break stopped unexpectedly. It will try again on your next task.` |
| setupHint | `☕ Run /coffee setup to chat with other people while Claude works.` |
| signin | `Sign in with GitHub to join coffee break. Press Enter to open GitHub.` |
| loginUrl | `If the browser doesn't open, visit: ${url}` |
| pickNick | `Pick a nickname (3–20 characters: a–z, 0–9, _ and -). Others only see this name.` |
| available / taken | `✓ ${nick} is available` / `✗ ${nick} is taken` |
| rules | `Room rules: be kind · no spam · don't share private or company data · moderators can remove you. Privacy: https://github.com/karli2000/coffeebreak#privacy. Type yes to accept.` |
| ready | `All set, ${nick}. The coffee room opens by itself when Claude works for more than ${min} s. Open it any time with /coffee while Claude is busy.` |
| deleteWarn | `This deletes your coffee break profile. Run /coffee delete-account yes to confirm.` |
| paneHelp | `/me <action> · /report <nick> <reason> · /leave` + mods: ` · /del <nick> [reason] · /mute <nick> <10|60|1440> <reason> · /ban <nick> <reason>` |

`errorText` codes:
- muted → `You're muted until ${HH:MM}.` (`You're muted.` without a time)
- rate_limited → `Slow down a little.`
- duplicate → `You just said that.`
- too_long → `Messages are at most 280 characters.`
- filtered → `That message was blocked by the word filter.`
- room_closed → `This room is closed.`
- forbidden → `You can't do that.`
- not_found → `Not found.`
- already_reported → `You already reported them recently.`
- cannot_report_self → `You can't report yourself.`
- nickname_invalid → `3–20 characters: a–z, 0–9, _ and -.`
- nickname_reserved → `That name is reserved.`
- nickname_taken → `That name is taken.`
- nickname_change_too_soon → `You can change your name once every 30 days.`
- not_signed_in → `Not signed in. Run /coffee setup.`
- network → `Can't reach coffee break, retrying…`
- realtime_unavailable → COPY.full
- login_failed → `GitHub sign-in failed. Run /coffee setup to try again.`
- else → `Something went wrong (${code}).`

- [ ] **Step 1: Write the failing tests**
  - `format.test.ts`:
    - `nickColor('lena') === '#42d753'`, `nickColor('Lena') === '#42d753'`, `nickColor('karli2000') === '#42a5d7'`, `nickColor('ravi') === '#d7425d'`.
    - `segments('hi @Lena!', 'lena')` → `[{text:'hi ',mention:false},{text:'@Lena',mention:true},{text:'!',mention:false}]`.
    - `segments('mail@lena.de', 'lena')` → no mention (needs start or whitespace before `@`).
    - `segments('@lena_x', 'lena')` → no mention (the next char must not be `[a-z0-9_-]`).
    - `splitLines('{"a"', ':1}\n{"b":2}\n{')` → `lines ['{"a":1}', '{"b":2}']`, `rest '{'`.
  - `commands.test.ts`:
    - `parseCoffeeArgs('')` → open; `'setup'` → setup; `'name Lena'` → `{name, nick:'lena'}`; `'room Lobby-DE'` → `{room, slug:'lobby-de'}`.
    - `'config min-wait 30'` → `config_set` value 30; `'config grace 999'` → invalid; `'config auto-open off'` → value false.
    - `'off'`/`'on'`; `'delete-account'` → `confirmed:false`; `'delete-account yes'` → `confirmed:true`; `'bogus'` → invalid.
    - `parsePaneInput('hello')` → say; `'//shrug'` → `say '/shrug'`; `'/me waves'` → `me 'waves'`.
    - `'/report @Ravi spamming links'` → `{report, nickname:'ravi', reason:'spamming links'}`; `'/report ravi'` → invalid (reason required).
    - `'/mute ravi 1h too loud'` → minutes 60; `'/mute ravi 5 x'` → invalid; `'/del ravi'` → reason null.
    - `'/ban ravi'` → invalid; `'/leave'`, `'/help'`; `'/xyz'` → invalid.
  - `settings.test.ts`:
    - `validateSetting('min-wait','0')` ok; `'601'` error; `'abc'` error; `validateSetting('grace','300')` ok.
    - `mergeStored({ graceSec: 'x', room: 'Bad Slug' })` equals `DEFAULTS`.
    - `mergeStored({ graceSec: 5 })` → `graceSec 5`.
- [ ] **Step 2:** Run `bun run test:unit` and confirm FAIL.
- [ ] **Step 3:** Implement the four files. Ranges: min-wait 0–600 s, grace 0–300 s; auto-open accepts `on|off|true|false`. Parsing strips a leading `@` and lowercases nicknames.
- [ ] **Step 4:** Run `bun run test:unit` and confirm PASS.
- [ ] **Step 5:** Commit `feat(mod): format, commands, copy, settings`.

### Task 6: Controller — break lifecycle and chat

**Files:**
- Create: `plugin/hooks/lib/controller.ts`, `tests/unit/fake-port.ts`, `tests/unit/controller-break.test.ts`

**Interfaces:**
- Consumes: Task 5 modules, `HelperEvent`, `Api`, `ApiPath`, `ApiResult`, `AuthState`.
- Produces:
  ```ts
  export interface Timer { cancel(): void }
  export interface Port {
    spawnHelper(onEvent: (e: HelperEvent) => void, onExit: (info: { code: number | null; signal: string | null; stderr: string }) => void): void
    stopHelper(): void
    call<P extends ApiPath>(socket: string, path: P, body: Api[P]['req']): Promise<ApiResult<P>>
    openPane(focus: boolean, title: string): Promise<{ placed: boolean }>   // title = COPY.title
    closePane(): Promise<boolean>          // false when refused or threw
    redraw(): void; scrollToEnd(): void
    status(text: string | undefined): void; toast(text: string): void
    after(ms: number, fn: () => void): Timer
    loadSettings(): Promise<Settings>; saveSettings(s: Settings): Promise<void>
  }
  export type Line = { kind: 'message'; id: number; nickname: string; color: string; action: boolean; segments: Segment[]; role?: Role } | { kind: 'system'; text: string }
  export type PaneView =
    | { mode: 'chat'; header: string; busy: boolean; lines: Line[]; draft: string; inputEnabled: boolean }
    | { mode: 'setup'; lines: string[]; draft: string; placeholder: string }
  export class Controller {
    constructor(port: Port)
    turnStart(): void; turnComplete(aborted: boolean): void; promptSubmitted(): void; sessionEnd(): void
    paneClosedByPerson(): void
    input(value: string): void; submit(value: string): Promise<void>
    command(args: string): Promise<string>          // Task 6: '' and idle rule only; Task 7 adds the rest
    view(): PaneView
  }
  ```
- `tests/unit/fake-port.ts`: `FakePort implements Port`. It records calls (`spawns`, `stops`, `calls: {path, body}[]`, `opens`, `closes`, `statuses`, `toasts`), lets a test `emit(e)`/`exit()` the fake helper, answers `call` from a per-path table, and has a manual clock `advance(ms)` that fires due `after` timers in order. `closeResult` is settable.

**Behavior** (phases `idle → pending → joining → break → grace → idle`, plus `left`):
- **`turnStart()`** (main loop only; the adapter filters subagents):
  - Sets `busy`. Does nothing if `!enabled`.
  - In `idle`/`left`-after-complete: go to `pending` and start a `minBusySec` timer.
  - In `grace`: cancel grace, add a `busyAgain` line, go back to `break`.
- **Timer, or `/coffee` while pending** → `startBreak(manual)`:
  1. Spawn the helper and wait for `hello` (10 s timeout → line `helperGone`, back to idle).
  2. Wait for its first `auth` event. Anything other than `ready`:
     - `signed_out`/`needs_*`: toast `setupHint` (once per session), stop the helper, back to idle.
     - `banned`: line `removed`, status unset, no joins for the rest of the session.
  3. `call('/join', { room })`, then `joined` + `backlog` events fill the lines and the phase becomes `break`.
  4. Open the pane: `focus = manual`. When auto and `!autoOpen`, don't open; status hint instead.
  5. Not placed → toast + status `statusHint`; placed → status `status`, then `scrollToEnd()`.
- **While the helper runs:** ping `/ping` every 20 s. Each `message`/`deleted`/`presence` event updates the lines (cap 200) and the header `title`, then `redraw()`.
- **`presence`:** add `joined`/`left` lines, and update `here` in the status.
- **`turnComplete(aborted)`:**
  - Clears `busy`.
  - In `pending`: cancel the timer, go to idle.
  - In `break`: add a `done` line, go to `grace`, start the `graceSec` timer.
- **Grace timer fires:**
  - If the draft is non-empty: add a `draftKept` line once and wait. A later `input('')` or `submit` while in grace and not busy re-checks.
  - Otherwise leave: `call('/leave')` (errors ignored), `stopHelper()`, `closePane()`. A `false` result sets `closePending`. Status `undefined`, phase idle.
- **`promptSubmitted()`:** if `closePending`, `closePane()` again.
- **`paneClosedByPerson()`** in `break`/`grace`: `/leave`, stop the helper, phase `left`. No auto re-join until a new turn starts after this one completes. `/coffee` while busy re-joins.
- **`submit(value)`** in chat mode, via `parsePaneInput`:
  - `say`/`me` → `/send` with body (`/me ` + text for `me`). On success clear the draft and call `scrollToEnd()`. On an error code, add a system line `errorText(code, {mutedUntil})`.
  - `report` → `/report` with `message_id` = id of the newest line by that nickname, or null; line `Reported ${nick}.`.
  - `del` → `/mod/delete` on the newest line by that nickname; `not_found` if none.
  - `mute`/`ban` → their routes. Moderators only: for non-staff, the line `errorText('forbidden')`.
  - `leave` → as `paneClosedByPerson` plus `closePane()`.
  - `help` → a `paneHelp` line (the mod part only for staff).
  - `invalid` → its error as a line.
- **Helper events:**
  - `kicked` → line `removed`, stop the helper, no joins for the rest of the session.
  - `room_closed` → `errorText('room_closed')` line, then leave as at grace end.
  - `error` → `errorText` line.
  - `connection reconnecting` → `reconnecting` line.
  - `joined` after the first → a `moved` line when the room or instance changed.
  - Unexpected helper exit during `break`/`grace` → `helperGone` line, phase `left`.
- **`sessionEnd()`:** `/leave` best effort, then `stopHelper()`.

- [ ] **Step 1: Write the failing tests** in `controller-break.test.ts` (FakePort; each test drives events and the fake clock):
  - `short turn never spawns the helper`: `turnStart`, advance 19 s, `turnComplete` → `spawns === 0`.
  - `long turn joins and opens the pane unfocused`:
    - `turnStart`, advance 20 s, emit hello + `auth ready` + `joined{here:3}`.
    - `calls[0]` is `/join {room:'lobby'}`, and `opens` matches `[{focus:false, title:'☕ lobby · 3 here'}]`.
    - With `placed:true`: status `☕ 3 on break` and `scrollToEnd` called.
  - `narrow terminal shows the hint`: `openPane` returns `placed:false` → toast and status `☕ 3 on break · /coffee to join`.
  - `not set up shows the setup hint once`: auth `signed_out` on two consecutive turns → one toast `setupHint`, `stops === 2`, no `/join`.
  - `claude done leaves after grace`:
    - From a break, `turnComplete(false)` → last line `Claude is done, back to work ☕`.
    - Advance 15 s → `/leave` called, `stops 1`, `closes 1`, last status `undefined`.
  - `new turn during grace keeps the room`: `turnComplete`, advance 5 s, `turnStart`, advance 20 s → no `/leave`, a line `Claude is busy again ☕`.
  - `draft holds the grace period`:
    - `input('typing')`, `turnComplete`, advance 15 s → no `/leave`, a `draftKept` line.
    - `input('')` → `/leave` called.
  - `refused close is retried on next prompt`: `closeResult=false`, `turnComplete(true)`, advance 15 s, `promptSubmitted()` → `closes === 2`.
  - `coffee while idle refuses`: `command('')` → the exact `idle` copy, `spawns === 0`.
  - `coffee while pending joins at once with focus`: `turnStart`, `command('')` → spawn before 20 s, `opens = [{focus:true}]`.
  - `closing the pane leaves until the next turn`:
    - `paneClosedByPerson()` → `/leave`, stop.
    - The timer from the same turn does not re-join.
    - After `turnComplete` + `turnStart` + 20 s → joins again.
  - `kicked stops for the session`: emit `kicked{reason:'spam'}` → line `You've been removed from coffee break: spam`. A later long turn → no spawn.
  - `pings while the helper runs`: in a break, advance 60 s → 3 `/ping` calls. After leave, advance 60 s → no more.
  - `keeps 200 lines and removes deleted ones`: 205 `message` events → 200 message lines; `deleted{id}` of one → gone.
  - `send errors become lines`: `/send` answers `{ok:false, code:'muted'}` with an `auth` `muted_until` of 14:05 local → line `You're muted until 14:05.`
  - `report uses the newest message by that nick`: lines from ravi with ids 4 and 9, `submit('/report ravi spam')` → `/report {nickname:'ravi', message_id:9, reason:'spam'}`.
  - `moderator commands are refused for users`: auth role `user`, `submit('/ban ravi x')` → no call, line `You can't do that.`
  - `disabled does nothing`: settings `enabled:false` → long turn, no spawn.
  - `helper crash during break`: `exit()` → line `helperGone`, a later turn joins again.
- [ ] **Step 2:** Run `bun test tests/unit/controller-break.test.ts` and confirm FAIL.
- [ ] **Step 3:** Implement `controller.ts` for these behaviors. `view()` returns `chat` mode here.
- [ ] **Step 4:** Run `bun run test:unit` and confirm PASS.
- [ ] **Step 5:** Commit `feat(mod): controller break lifecycle and chat`.

### Task 7: Controller — setup flow and `/coffee` commands

**Files:**
- Modify: `plugin/hooks/lib/controller.ts`
- Create: `tests/unit/controller-setup.test.ts`

**Interfaces:**
- Consumes: the Task 6 `Controller`, `Port`, `FakePort`; `parseCoffeeArgs`, `validateSetting`, `COPY`.
- Produces: `Controller.command(args)` for every `CoffeeCommand`, and `view()` in `setup` mode while a setup runs.

**Behavior:**
- **Commands that need the helper while none runs** (setup, name, logout, delete-account) spawn it with `withHelper`. They stop it again afterwards unless a break is running.
- **`setup`:**
  - Open the pane focused (a user command, so it is placed at any width). The view follows the helper's `auth` state.
  - `signed_out`: show `signin`; submit → `/login`, show the `loginUrl` line.
  - `needs_nickname`: show `pickNick`.
    - Each `input` is checked locally first (`^[a-z0-9_-]{3,20}$` after lowercasing; otherwise show the `nickname_invalid` text).
    - Then a 400 ms debounce → `/nickname/check` → `available`/`taken` line.
    - Submit → `/nickname/claim`; errors become `errorText`.
  - `needs_rules`: show `rules`; submit `yes` (case-insensitive) → `/rules/accept`; anything else repeats the rules.
  - `ready`: show the `ready` line. Return the command text `You're signed in as ${nick}.`. Stop the helper unless busy. If busy, `startBreak(manual)`.
  - `banned`: the `removed` line.
- **`status`** → multi-line text:
  - `Signed in as <nick> (<role>)` or `Not signed in`.
  - `Room: <room> · min wait <n> s · grace <n> s · auto-open on|off · enabled|disabled`.
  - `On break: yes|no`.
  - Getting the auth state needs a short-lived helper (`/status`); show `Not signed in` when the helper reports `signed_out`.
- **`name <nick>`** → `/nickname/claim` → `Your nickname is now ${nick}.` or `errorText`.
- **`room <slug>`:** invalid slug → `Room names are 2–32 characters: a–z, 0–9 and -.`; else save → `Room set to ${slug}. It applies from your next break.`.
- **`config`** → the same settings line as status.
- **`config_set`** → validate, save → `Saved.`.
- **`off`:** `enabled=false` (leave if on a break) → `Coffee break is off. /coffee on turns it back on.`.
- **`on`** → `Coffee break is on.`.
- **`logout`** → `/logout` → `Signed out.`.
- **`delete_account`:** unconfirmed → `deleteWarn`; confirmed → `/delete-account` → `Your coffee break profile was deleted.`.
- **`invalid`** → its error plus `Commands: /coffee [setup|status|name|room|config|on|off|logout|delete-account]`.

- [ ] **Step 1: Write the failing tests** (FakePort):
  - `setup walks sign-in, nickname, rules`:
    - auth `signed_out` → view lines include `signin`.
    - `submit('')` → `/login`; emit `login{url}` → a `loginUrl` line.
    - Emit `auth needs_nickname`; `input('ab')` → a `nickname_invalid` line, no call.
    - `input('lena')`, advance 400 ms → `/nickname/check {nick:'lena'}`, line `✓ lena is available`.
    - `submit('lena')` → `/nickname/claim`.
    - Emit `needs_rules`; `submit('no')` → no call; `submit('YES')` → `/rules/accept`.
    - Emit `ready` → a `ready` line, and the helper stopped (idle).
  - `setup when already signed in`: auth `ready` → `command('setup')` returns `You're signed in as lena.`
  - `setup while busy starts the break when ready`: `turnStart`, `command('setup')`, … `ready` → `/join` called.
  - `name change maps errors`: `/nickname/claim` → `nickname_change_too_soon` → the reply is that copy.
  - `room validates and saves`: `command('room x')` → invalid copy; `command('room lobby-de')` → `saveSettings` with `room:'lobby-de'`.
  - `config set saves`: `command('config grace 30')` → saved `graceSec 30`.
  - `off during a break leaves`: in a break, `command('off')` → `/leave`, and a later turn does nothing.
  - `delete-account needs yes`: without `yes` → `deleteWarn`, no call; with `yes` → `/delete-account`.
- [ ] **Step 2:** Run the tests and confirm FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun run test:unit` and confirm all pass.
- [ ] **Step 5:** Commit `feat(mod): setup flow and /coffee commands`.

### Task 8: Mod wiring, pane, plugin tests, owner run

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `plugin/hooks/register.ts`, `plugin/hooks/pane.ts`, `plugin/tests/mod.test.ts`
- Delete: `spikes/mod-pane/`, `spikes/login/`. Keep `spikes/FINDINGS.md`.
- Modify: `CLAUDE.md`, `docs/deploy.md` (if the owner run changes anything)

**Interfaces:**
- Consumes: `Controller`, `Port`, `PaneView` (Tasks 6–7), `nickColor`, `splitLines`, `COPY`.
- Produces:
  - `renderPane(view: PaneView, els: { Box; Text; Input }, on: { input(v: string): void; submit(v: string): void }): RenderElement`.
  - Chat view:
    - A dim header line.
    - Message lines as a bold colored nickname plus `: ` and segments; mentions drawn bold + inverse.
    - `/me` lines as `* nick action` in italics.
    - System lines dim.
    - An `Input` with key `say`, placeholder `say something` (setup: key `setup`, placeholder from the view), controlled by `draft`.
  - `register.ts` exports `register` and builds one `Controller` with a Port over the latest `$`:
    - `spawnHelper` → `$.process.spawn({ argv: ['bun', `${$.plugin.root}/helper/main.ts`] })` and a pump loop as in the spike (stdout lines via `splitLines`, stderr kept for the last 2000 chars).
    - `stopHelper` → `stream.return()`.
    - `call` → `$.http.fetch('http://localhost' + path, { method: 'POST', socketPath, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })`, reading the body as the types allow.
    - `openPane(focus, title)` → `$.ui.open({ id: 'coffee', title, ...(focus ? { focus: true } : {}) })`. Re-open with the new title when `here` changes while open.
    - `closePane` → `$.ui.close({ id: 'coffee' })`.
    - `redraw` → `$.ui.invalidate('ui.render')`.
    - `scrollToEnd` → `$.ui.scroll({ in: 'coffee', to: 'end' })`.
    - `after` → `$.clock.after`.
    - Settings → `$.store.get/set('settings')` through `mergeStored`.
  - Hooks:
    - `session.start`: register command `coffee` (argumentHint `[setup|status|name|room|config|on|off|logout|delete-account]`, `immediate: true`).
    - `turn.start` / `turn.complete`: ignore `agentId !== undefined`; pass only `isAborted`.
    - `prompt.submit` → `promptSubmitted()`.
    - `session.end` → `sessionEnd()`.
    - `command.run {command:'coffee'}` → `{ text: await controller.command(e.args) }`.
    - `ui.close {id:'coffee'}` with `origin.kind === 'person'` → `paneClosedByPerson()`.
    - `ui.render {component:'Pane', requestId:'coffee'}` → `renderPane(controller.view(), …)`. No writes while drawing (spike rule).

- [ ] **Step 1:** Create `plugin.json` and `hooks.json`, then run `claude --plugin-dir plugin -p "hi"` once so the engine writes `plugin/.claude-plugin/types/`. Confirm `claude plugin test --help` exists in 2.1.322. Read the `claude-code/testing` part of the types (`mock.clock`, `mock.store`, `$.ui.mount`, raising events on the test's `$`, hooks a test registers via `on`).
- [ ] **Step 2: Write the failing plugin tests** in `plugin/tests/mod.test.ts` (`claude plugin test plugin`):
  - `registers /coffee`.
  - `coffee while idle answers the idle rule`: run the command with no turn → the exact `idle` copy.
  - `subagent turns are ignored`: raise `turn.start` with `agentId`, advance the mock clock 25 s → no `process.spawn`. Stub `process.spawn` beneath the plugin with the test's `on` and count calls.
  - `prompt text never reaches spawn or fetch`:
    - Submit/raise a turn whose prompt text is `SECRET-PROMPT-1234`.
    - Advance 25 s.
    - Answer the stubbed `process.spawn` with a stream that prints hello + `auth ready` + `joined`, and the stubbed `http.fetch` with `{ok:true,data:{}}`.
    - Assert no spawn argv/env and no fetch body contains `SECRET-PROMPT-1234`.
  - `pane draws messages and the input`: mount the `coffee` pane on `terminal` after a `message` event from `lena` → a Text with `lena`, and an Input with key `say`.
  - If the kit cannot answer `process.spawn` with a stream, keep the first three tests, cover the last two at the Controller level in `tests/unit` instead, and write that down in `CLAUDE.md`.
- [ ] **Step 3:** Run `bun run test:mod` and confirm FAIL.
- [ ] **Step 4:** Implement `pane.ts` and `register.ts`.
- [ ] **Step 5:** Run `bun run test:mod` and confirm PASS, and that `claude plugin validate plugin` reports no errors. Then run `bun run test:unit` and `bun run test:int` and confirm all pass.
- [ ] **Step 6: Owner run** (hosted backend, real GitHub). The owner runs `bun run dev` in their normal WSL terminal and checks:
  1. `/coffee setup`: GitHub login opens in the Windows browser, nickname check is live, rules accept, ready.
  2. A long task (e.g. "count to 60 slowly using sleep 1 in bash, one number per call"): after 20 s, the toast or status `☕ N on break · /coffee to join` (at 100 columns).
  3. `/coffee` opens the pane focused; backlog shown; typing and sending works; the input stays in view as messages arrive.
  4. A second account or a friend sees the messages with the same nickname colors.
  5. The task ends → `Claude is done, back to work ☕`, then the pane closes after 15 s. With a draft typed, it stays.
  6. Esc mid-task: the pane may stay open, and the next prompt closes it.
  7. Closing the terminal window mid-break: within about 60 s, `pgrep -af helper/main.ts` is empty.

  Record the results in `spikes/FINDINGS.md` under "Plan 2 owner run".
- [ ] **Step 7:** Delete `spikes/mod-pane/` and `spikes/login/` (FINDINGS.md stays). Update `CLAUDE.md`:
  - Plugin section: commands, architecture, test commands, decisions below.
  - "Next up" → Plan 3.
- [ ] **Step 8:** Commit `feat(mod): Coffee Break mod, pane and /coffee` (then a separate `chore: remove spikes` commit).

---

## Decisions this plan makes (beyond the spec)

- **Mod → helper:** a Unix socket only. The access token never enters the mod (spec 4.5 left it open; S1 showed it works).
- **Login storage:** the login lives in `~/.config/coffeebreak/auth.json`, not `${CLAUDE_PLUGIN_DATA}`. Mod settings live in `$.store`.
- **Refresh:** token refresh is manual (`autoRefreshToken: false`), behind a cross-process lock, so parallel sessions don't trip refresh-token reuse detection.
- **Helper lifetime:** the helper lives only for a break, setup or command. A 60 s idle exit and a parent-death check stop it when Claude can't, for example after the refused close following Esc.
- **`/coffee config`:** subcommands only, no settings view in the pane.
- **Reporting:** `/report <nick> <reason>` attaches that nick's newest visible message. Selecting a message and pressing `r` is deferred to a later plan.
- **`/me`:** sent as the literal body `/me …` and drawn as an action by clients.
- **"↓ new messages" hint:** not built. `$.ui.scroll(to: 'end')` follows new rows until the user scrolls, and the mods API exposes no scroll position to detect "scrolled up".
- **API-error stops:** no `StopFailure` hook. `turn.complete` fires for API errors too (its `usage` is absent then), so one path covers every end.
- **Keybinding:** `/coffee` only (spec 4.4 left the key to the builder).
- **Closing the pane:** leaves the room for the rest of that turn. `/coffee` re-joins while Claude is busy.
