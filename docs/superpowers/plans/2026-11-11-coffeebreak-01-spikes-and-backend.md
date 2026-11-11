# Coffee Break, Plan 1: Spikes + Supabase Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three big unknowns with throwaway spikes, then build and deploy the complete, tested Supabase backend: schema, chat RPCs, rate limits, room instances, reports, moderation, realtime authorization and retention.

**Architecture:** All logic lives in Postgres: tables with RLS, plus `SECURITY DEFINER` RPC functions that check the caller's role and broadcast to Supabase Realtime with `realtime.send`. Clients may only *track presence* on Realtime. They never broadcast chat directly. Development runs against the local Supabase stack (Docker). Tests are pgTAP (`supabase test db`) for SQL and `bun test` + supabase-js for realtime integration.

**Tech Stack:** Supabase (Postgres 17, Auth, Realtime, pg_cron, Edge Functions), Supabase CLI via `bunx supabase`, pgTAP, Bun 1.4 (`bun test`), `@supabase/supabase-js` v2, Docker.

**Spec:** `docs/superpowers/specs/2026-11-11-coffeebreak-design.md`

**Roadmap (later plans, written after this one's spikes report back):**
- Plan 2: helper `coffeebreakd` + Claude Code plugin/mod (depends on spike S1 and S3 findings)
- Plan 3: static moderator site (Cloudflare R2/Pages)
- Plan 4: packaging, marketplace, friends beta

## Global Constraints

- Hosting: owner's own Supabase account, **free tier**, project name `coffeebreak`, friends-only beta.
- Clients **never** broadcast chat. Only `extension = 'presence'` inserts on `realtime.messages` are allowed for clients.
- The nickname shown on a message is always taken from `profiles` server-side, never from client input.
- Message body: trimmed, 1–280 characters, all control characters (C0, C1, DEL, including newlines and ESC) stripped server-side.
- Rate limits: ≥2 s between messages; ≤5 messages per 10 s; identical body by the same user within 60 s is rejected.
- Young GitHub accounts (`github_created_at` > now() − 30 days, **or unknown**): ≥10 s between messages.
- Room instances: max **50** people each. Topic format: `room:<slug>:<n>`, n ≥ 1.
- Nicknames: `^[a-z0-9_-]{3,20}$` after lowercasing, case-insensitive unique. Reserved: `admin, administrator, mod, moderator, claude, anthropic, system, coffee, coffeebreak, root, support, staff`. One change per 30 days.
- Auto-mute: 3 distinct reporters against the same user within 10 min → muted for 24 h, logged as `auto_mute`.
- Mute durations: exactly 10, 60 or 1440 minutes.
- Roles: `user` < `moderator` < `admin`. Staff can only act on users with a strictly lower role.
- Retention: messages 15 min; occupancy rows stale after 90 s; resolved reports 90 days; `mod_actions` 1 year.
- RPC errors are raised as `raise exception '<code>'` with SQLSTATE `P0001`, where `<code>` is one of: `not_authenticated, no_profile, banned, muted, rate_limited, too_long, empty, duplicate, filtered, not_in_room, room_closed, nickname_invalid, nickname_reserved, nickname_taken, nickname_change_too_soon, rules_not_accepted, forbidden, not_found, invalid_duration, cannot_report_self, already_reported, invalid_pattern`.
- No prompt, code, file or project data is ever stored. The backend has no columns for it.

## Review Focus

1. **Terminal escape injection:** a message containing `\x1b[2J` or OSC sequences must arrive with all control characters removed. It will be rendered in people's terminals. → test in Task 5.
2. **Concurrent sends bypassing rate limits:** two parallel `send_message` calls from one user must not both pass. Serialize per user with `pg_advisory_xact_lock`. → test in Task 5 (integration, parallel calls).
3. **Ban while in the room:** a banned user must be removed from occupancy, receive `kicked`, and be unable to re-subscribe or send. → tests in Tasks 7 and 8.
4. **Reporting a purged or cross-room message:** reporting a message id that no longer exists returns `not_found`, and the snapshot only includes lines from the same instance. → test in Task 6.
5. **Case and look-alike nicknames:** `Max` vs `max` collide; non-ASCII look-alikes (`mаx` with Cyrillic а) are rejected by the regex. A changed nickname frees the old one. → tests in Task 3.

---

## Phase A: Spikes (throwaway, no TDD, no reuse of code)

Each spike writes its answers into `spikes/FINDINGS.md` under its own heading. Spike code is deleted once Plan 2 is written.

### Task S1: Mod pane spike

**Files:**
- Create: `spikes/mod-pane/.claude-plugin/plugin.json`, `spikes/mod-pane/hooks/hooks.json`, `spikes/mod-pane/register.js`, `spikes/mod-pane/ticker.ts`
- Create/append: `spikes/FINDINGS.md`

- [ ] **Step 1:** Get the mods types for the installed build (`claude --version` is 2.1.322; follow `https://code.claude.com/docs/en/plugins/mods/create.md#get-the-types-for-your-build`). Use only API names that exist in those types.
- [ ] **Step 2:** Write a minimal mod with these parts:
  - `turn.start` (main agent only) waits 5 s, then opens a pane `coffee-spike` containing a message list and an `Input`.
  - It starts `bun ticker.ts` with `$.process.spawn`. `ticker.ts` prints `{"type":"message","nick":"bot","body":"tick N"}` once a second.
  - It renders each line it reads.
  - `onSubmit` of the Input appends `me: <text>` locally.
  - `turn.complete` shows "back to work" and closes the pane after 5 s, unless the Input has text.
  - It registers the command `/coffee-spike` to open the pane manually.
- [ ] **Step 3:** Run `claude plugin validate spikes/mod-pane`. Expected: no errors.
- [ ] **Step 4:** Have the owner run `claude --plugin-dir spikes/mod-pane` in their normal WSL terminal and give Claude a long task (e.g. "count to 200 slowly using sleep 1 in bash").
- [ ] **Step 5:** Record answers in `spikes/FINDINGS.md`:
  1. Does the pane auto-open at the owner's real terminal width? (The current shell reports 80 columns; auto-place needs ≥144, or ≥110 after a first manual open.)
  2. Does `turn.start` fire for queued prompts?
  3. Does `turn.complete` fire with `isAborted` on Esc?
  4. Does the spawned process die when the pane closes, on `/exit`, and when the terminal is closed? Check with `pgrep -f ticker.ts`.
  5. Can the mod write to the spawned process's stdin? If not, is `$.http.fetch` to `http://127.0.0.1:<port>` allowed?
  6. Does typing in the Claude prompt ever leak into the pane Input, or the reverse?
- [ ] **Step 6:** Commit `spikes/` with message `spike: mod pane findings`.

### Task S3: GitHub login spike (run after Task 11, Step 4, since it needs the hosted project and GitHub OAuth app)

**Files:** Create `spikes/login/login.ts`. Append to `spikes/FINDINGS.md`.

- [ ] **Step 1:** Write a Bun script that does the following:
  - Starts `Bun.serve` on `127.0.0.1:0`.
  - Calls `supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: 'http://127.0.0.1:<port>/callback', skipBrowserRedirect: true } })` with the client created with `auth: { flowType: 'pkce', persistSession: false }`.
  - Opens the returned URL with `explorer.exe "<url>"` on WSL, `xdg-open` on Linux, or `open` on macOS.
  - On `/callback?code=…` calls `exchangeCodeForSession(code)` and prints `user.id` and `user.identities[0].identity_data`.
- [ ] **Step 2:** Run `bun spikes/login/login.ts` with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set. Expected: the browser opens, the owner approves, and the user id is printed.
- [ ] **Step 3:** Record in FINDINGS:
  - Does the redirect to `127.0.0.1` with a random port work? Supabase needs the redirect allow-list entry `http://127.0.0.1:*/callback`, or a fixed port range if wildcards are refused.
  - Does `identity_data` contain the numeric GitHub id (`provider_id`)? Does it contain the account creation date?
  - How long does the refresh token stay valid?
- [ ] **Step 4:** Commit with message `spike: github login findings`.

(Spike S2, the Supabase realtime policies, is folded into Task 8 as a real tested task.)

---

## Phase B: Backend

### Task 1: Repository and local Supabase stack

**Files:**
- Create: `.gitignore`, `package.json`, `supabase/` (via `supabase init`), `supabase/tests/000_smoke.test.sql`, `README.md`

**Interfaces:**
- Produces:
  - `bun run db:start` → `bunx supabase start`
  - `bun run db:reset` → `bunx supabase db reset`
  - `bun run db:test` → `bunx supabase db reset && bunx supabase test db`
  - `bun run test:int` → `bun test tests/integration`

- [ ] **Step 1:** Run `git init` and create `.gitignore`. It must contain `.superpowers/`, `node_modules/`, `.env*`, `supabase/.temp/` and `supabase/.branches/`.
- [ ] **Step 2:** Run `bun init -y`. Add `@supabase/supabase-js` and dev dependency `supabase` (the CLI). Add the four scripts above.
- [ ] **Step 3:** Run `bunx supabase init`. In `supabase/config.toml` set `[db] major_version = 17` and enable `[realtime]`.
- [ ] **Step 4:** Write `supabase/tests/000_smoke.test.sql` as a pgTAP test that asserts `has_extension('pgtap')` passes and `select 1 = 1`.
- [ ] **Step 5:** Run `bun run db:start && bun run db:test`. Expected: `All tests successful.`
- [ ] **Step 6:** Commit with message `chore: repo + local supabase stack`.

### Task 2: Schema, roles and base RLS

**Files:**
- Create: `supabase/migrations/20261111000100_schema.sql`, `supabase/tests/010_schema_rls.test.sql`, `supabase/tests/_helpers.sql` (shared test helpers, loaded with `\ir`)

**Interfaces:**
- Produces (types and tables):
  - `create type public.app_role as enum ('user','moderator','admin')`
  - `create type public.report_status as enum ('open','dismissed','actioned')`
  - `profiles(id uuid pk references auth.users on delete cascade, github_id bigint unique, nickname citext unique, role app_role not null default 'user', github_created_at timestamptz, rules_accepted_at timestamptz, muted_until timestamptz, banned_at timestamptz, ban_reason text, nickname_changed_at timestamptz, created_at timestamptz not null default now())`
  - `rooms(slug text pk check (slug ~ '^[a-z0-9-]{2,32}$'), title text not null, kind text not null default 'public', lang text, is_open boolean not null default true)`. The seed inserts `('lobby','Lobby')`.
  - `occupancy(user_id uuid pk references profiles on delete cascade, room text not null references rooms, instance int not null check (instance >= 1), last_seen timestamptz not null default now())`
  - `messages(id bigint generated always as identity pk, room text not null, instance int not null, user_id uuid references profiles on delete set null, nickname citext not null, body text not null, created_at timestamptz not null default now(), deleted_at timestamptz, deleted_by uuid)`, with index `(room, instance, created_at)` and index `(user_id, created_at desc)`
  - `reports(id bigint identity pk, reporter_id uuid references profiles on delete set null, target_id uuid references profiles on delete set null, message_id bigint, room text, instance int, reason text not null check (char_length(reason) between 1 and 500), snapshot jsonb not null, status report_status not null default 'open', handled_by uuid, handled_at timestamptz, created_at timestamptz not null default now())`
  - `mod_actions(id bigint identity pk, actor_id uuid, target_id uuid, action text not null, reason text, details jsonb not null default '{}', created_at timestamptz not null default now())`
  - `word_filter(id bigint identity pk, pattern text not null unique, created_by uuid, created_at timestamptz not null default now())`. Each pattern is a case-insensitive POSIX regex.
  - SQL functions (all `stable security definer set search_path = ''`):
    - `public.current_role_of(uid uuid) returns app_role`
    - `public.is_staff() returns boolean` (moderator or admin)
    - `public.is_admin() returns boolean`
  - Test helpers in `_helpers.sql`:
    - `tests.create_user(nick text, role app_role default 'user', github_age interval default '1 year') returns uuid`. It inserts the `auth.users` row and a profile with rules accepted.
    - `tests.login_as(uid uuid)`, which sets `role authenticated` and `request.jwt.claims` with `sub`.
    - `tests.logout()`

- [ ] **Step 1: Write the failing test** in `010_schema_rls.test.sql`. Assertions:
  - `has_table` for each of the 7 tables.
  - RLS is enabled on all 7 tables (`select bool_and(relrowsecurity)` from `pg_class`).
  - As a `user`: `select count(*) from reports` = 0 even when a report exists, `select count(*) from mod_actions` = 0, and `select count(*) from word_filter` = 0.
  - As a `user`: may select own full profile, and for other profiles only through view `public.public_profiles(id, nickname, role)`.
  - As a `user`: `insert into messages …` throws (no direct writes, since all writes go through RPCs).
  - As a `moderator`: `select count(*) from reports` = 1.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL (tables missing).
- [ ] **Step 3:** Write the migration.
  - Revoke `insert, update, delete` on all 7 tables from `anon, authenticated`. Grant `select` where a policy allows it.
  - Policies:
    - `profiles`: own row.
    - `rooms`: all authenticated.
    - `messages`: authenticated, `deleted_at is null`.
    - `reports`, `mod_actions`, `word_filter`: `is_staff()`.
    - `occupancy`: own row, plus staff.
  - `public_profiles` is a `security_invoker = false` view exposing only `id, nickname, role`.
  - Enable `citext` and `pg_cron`.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): schema, roles, base RLS`.

### Task 3: Profile and nickname RPCs

**Files:**
- Create: `supabase/migrations/20261111000200_profiles.sql`, `supabase/tests/020_profiles.test.sql`

**Interfaces:**
- Consumes: Task 2 tables and helpers.
- Produces:
  - `public.nickname_available(nick text) returns boolean`
  - `public.claim_nickname(nick text) returns public.profiles`. It creates the profile on first call (copying `github_id` from `auth.identities.provider_id` where `provider = 'github'`) or renames it.
  - `public.accept_rules() returns void`
  - `public.my_profile() returns public.profiles`

- [ ] **Step 1: Write the failing tests:**
  - `nickname_available('max')` = true. After `claim_nickname('max')`, `nickname_available('MAX')` = false.
  - `claim_nickname('Max_K')` stores `max_k`.
  - `claim_nickname('ma')` throws `nickname_invalid`. So do `claim_nickname('mаx')` (Cyrillic а) and `claim_nickname('a b c')`.
  - `claim_nickname('admin')` throws `nickname_reserved`.
  - A second user calling `claim_nickname('max')` throws `nickname_taken`.
  - Renaming within 30 days throws `nickname_change_too_soon`. With `nickname_changed_at` set back 31 days, the rename succeeds and `nickname_available('max')` = true again.
  - A call without a JWT throws `not_authenticated`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Lowercase first, check the regex, then the reserved list, then uniqueness, all inside `security definer set search_path = ''`. The first claim does not count as a "change".
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): nickname + profile RPCs`.

### Task 4: Room instances and occupancy

**Files:**
- Create: `supabase/migrations/20261111000300_rooms.sql`, `supabase/tests/030_rooms.test.sql`

**Interfaces:**
- Produces:
  - `public.join_room(room_slug text) returns jsonb`, which returns `{"room": "<slug>", "instance": <n>, "topic": "room:<slug>:<n>", "here": <count>}`
  - `public.heartbeat() returns jsonb`, which returns the same shape for the caller's current occupancy, or throws `not_in_room`
  - `public.leave_room() returns void`
  - `public.room_counts() returns table(room text, instance int, here int)`, counting only live rows (`last_seen > now() - interval '90 seconds'`)

- [ ] **Step 1: Write the failing tests:**
  - The first user to `join_room('lobby')` gets instance 1, `here` 1, and topic `room:lobby:1`.
  - With 50 live occupants in instance 1, the 51st gets instance 2.
  - With instance 1 at 30 and instance 2 at 10, a new joiner gets instance 1 (fullest with space).
  - Rows with `last_seen` older than 90 s don't count.
  - Joining again moves the caller (one row per user).
  - `join_room('nope')` throws `not_found`. A room with `is_open = false` throws `room_closed`.
  - A banned user throws `banned`. A user without `rules_accepted_at` throws `rules_not_accepted`.
  - `leave_room()` deletes the row, and `heartbeat()` after leaving throws `not_in_room`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Take `pg_advisory_xact_lock(hashtext('room:' || room_slug))` in `join_room` so two joiners can't overfill an instance. Among instances with a live count < 50, pick the one with the highest count (ties go to the lower number). If none exists, use the smallest positive integer not currently in use.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): room instances + occupancy`.

### Task 5: send_message with limits and filter

**Files:**
- Create: `supabase/migrations/20261111000400_send_message.sql`, `supabase/tests/040_send_message.test.sql`

**Interfaces:**
- Consumes: `occupancy`, `profiles`, `word_filter`.
- Produces: `public.send_message(body text) returns public.messages`. It sends to the caller's current occupancy instance and broadcasts `realtime.send(payload => jsonb_build_object('id',id,'nickname',nickname,'body',body,'created_at',created_at,'role',role), event => 'message', topic => 'room:<slug>:<n>', private => true)`.

- [ ] **Step 1: Write the failing tests.** Each `send_message` call checks its result or error code:
  - Happy path: the returned row has `nickname` from the profile (not client input), and `realtime.messages` has a row with `topic = 'room:lobby:1'` and `event = 'message'`.
  - `E'hi\x1b[2Jthere\n\x07'` is stored as `hithere`.
  - `'   '` → `empty`. A 281-char body → `too_long`. A 280-char body succeeds.
  - Two messages with `created_at` 1 s apart → the second raises `rate_limited`. Simulate by inserting the earlier message with `created_at = now() - interval '1 second'`.
  - Five messages in the last 10 s, spaced ≥2 s → the 6th raises `rate_limited`.
  - Same body within 60 s → `duplicate`.
  - Young account (`github_created_at = now() - interval '5 days'`) with the last message 5 s ago → `rate_limited`. Null `github_created_at` behaves as young.
  - A `word_filter` pattern `'b[a@]dword'` matches `'BAdword'` → `filtered`.
  - `muted_until > now()` → `muted`. `banned_at` set → `banned`. No occupancy row → `not_in_room`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Start with `pg_advisory_xact_lock(hashtext('send:' || auth.uid()))`. Strip control characters with `regexp_replace(body, '[\u0000-\u001F\u007F-\u009F]', '', 'g')`, then trim. Order checks: auth → profile → banned → muted → occupancy → empty/too_long → rate limits → duplicate → filter. Also refresh `occupancy.last_seen`.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): send_message with limits, filter, broadcast`.

### Task 6: Reports and auto-mute

**Files:**
- Create: `supabase/migrations/20261111000500_reports.sql`, `supabase/tests/050_reports.test.sql`

**Interfaces:**
- Produces: `public.report_user(target_nickname text, message_id bigint, reason text) returns bigint`, which returns the report id. `message_id` may be null.
- Snapshot shape: `{"message": {id, nickname, body, created_at} | null, "context": [{id, nickname, body, created_at}, …]}`. The context is up to 10 messages from the **same room and instance** with `created_at` within ±5 min of the reported message, or the target's instance's last 10 messages when `message_id` is null.

- [ ] **Step 1: Write the failing tests:**
  - A report creates a row with `status = 'open'` and a snapshot containing the message and context. Context only includes lines from the same instance: insert a message in instance 2 at the same time and assert it's absent.
  - Reporting yourself → `cannot_report_self`. Unknown nickname → `not_found`. A message id that doesn't exist (purged) → `not_found`. A message id that belongs to someone else than the target → `not_found`.
  - The same reporter and target within 10 min → `already_reported`.
  - With 3 distinct reporters within 10 min, the target gets `muted_until ≈ now() + 24h` and `mod_actions` has a row with `action = 'auto_mute'` and `actor_id` null. With 2 reporters, the target is not muted.
  - A reason of 0 chars → `empty`. 501 chars → `too_long`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): reports + auto-mute`.

### Task 7: Moderation and admin RPCs

**Files:**
- Create: `supabase/migrations/20261111000600_moderation.sql`, `supabase/tests/060_moderation.test.sql`

**Interfaces:**
- Produces. All write to `mod_actions` with `action` set to the function's verb.
  - `public.mod_delete_message(message_id bigint, reason text) returns void`. It sets `deleted_at`/`deleted_by` and broadcasts event `deleted` `{id}` to the message's topic.
  - `public.mod_mute(target uuid, minutes int, reason text) returns void`. `minutes ∈ {10, 60, 1440}`, else `invalid_duration`.
  - `public.mod_unmute(target uuid, reason text) returns void`
  - `public.mod_ban(target uuid, reason text) returns void`. It sets `banned_at`/`ban_reason`, deletes the target's occupancy, and broadcasts event `kicked` `{user_id, reason}` to the target's topic.
  - `public.mod_resolve_report(report_id bigint, status report_status) returns void`. `status` is `dismissed` or `actioned`. It sets `handled_by` and `handled_at`.
  - `public.admin_unban(target uuid, reason text) returns void`
  - `public.admin_set_role(target uuid, new_role app_role) returns void`
  - `public.admin_upsert_room(slug text, title text, kind text, lang text, is_open boolean) returns void`
  - `public.admin_add_filter(pattern text) returns bigint` and `public.admin_remove_filter(id bigint) returns void`. Patterns are validated by compiling them, and an invalid regex raises `invalid_pattern`.
  - `public.mod_lookup_user(nickname text) returns jsonb` → `{profile, reports_against, actions_against}` for the moderator site.

- [ ] **Step 1: Write the failing tests:**
  - A `user` calling any `mod_*` or `admin_*` → `forbidden`. A `moderator` calling `admin_*` → `forbidden`.
  - A moderator banning another moderator or an admin → `forbidden`. An admin banning a moderator succeeds.
  - `mod_ban` deletes occupancy, `realtime.messages` has a `kicked` event on the target's topic, and the target's `send_message` → `banned`, `join_room` → `banned`.
  - `mod_mute(target, 15, 'x')` → `invalid_duration`.
  - `mod_delete_message`: the row is hidden from `select … from messages` for users, and a `deleted` event is broadcast.
  - Every successful call adds exactly one `mod_actions` row with the correct actor, target and action.
  - `admin_add_filter('(')` → `invalid_pattern`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Share one internal guard `private.require_rank_over(target uuid, min_role app_role)`. Put it in schema `private`, which is not exposed by the API.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): moderation + admin RPCs`.

### Task 8: Realtime authorization and integration tests (replaces spike S2)

**Files:**
- Create: `supabase/migrations/20261111000700_realtime_policies.sql`, `tests/integration/realtime.test.ts`, `tests/integration/_env.ts`

**Interfaces:**
- Produces:
  - Policies on `realtime.messages`:
    - SELECT for `authenticated` where `realtime.topic() like 'room:%'`, the caller is not banned, and either the caller's occupancy topic equals `realtime.topic()` or `is_staff()`.
    - INSERT for `authenticated` only where `extension = 'presence'` and the same topic condition holds.
  - `_env.ts` exports `adminClient()` (service role from `bunx supabase status -o json`) and `userClient(nick: string, role?: 'user'|'moderator'|'admin'): Promise<SupabaseClient>`. The latter creates the user with email/password via the admin API, signs in, claims the nickname, accepts the rules, and sets the role via the service role.

- [ ] **Step 1: Write the failing tests** with `bun test`, against the local stack. The client config is `{ realtime: { params: { eventsPerSecond: 20 } } }`, and each channel uses `config: { private: true, presence: { key: user.id } }`.
  - `alice` and `bob` join `lobby`, subscribe to the returned topic and receive `SUBSCRIBED`. When `alice` calls `send_message('hello')`, `bob` receives a broadcast `message` with `nickname: 'alice'` within 3 s.
  - `alice` calling `channel.send({ type: 'broadcast', event: 'message', payload: { nickname: 'bob', body: 'fake' } })` → `bob` receives nothing within 2 s.
  - Presence: after both `track({})`, `presenceState()` has 2 keys.
  - `carol`, who hasn't joined the room, subscribing to `room:lobby:1` → the status is not `SUBSCRIBED` (`CHANNEL_ERROR`).
  - A moderator bans `bob` → `bob` receives `kicked`, and `bob` re-subscribing fails.
  - Review Focus #2: `alice` fires 3 `send_message` calls in parallel with `Promise.all` → exactly 1 succeeds and 2 return `rate_limited`.
- [ ] **Step 2:** Run `bun run db:reset && bun run test:int`. Expected: FAIL.
- [ ] **Step 3:** Write the policy migration. Note: `realtime.send` fails until a client has connected once that day (daily partition), so the test opens a channel before the first send.
- [ ] **Step 4:** Run `bun run db:reset && bun run test:int`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): realtime authorization + integration tests`.

### Task 9: Retention jobs and account deletion

**Files:**
- Create: `supabase/migrations/20261111000800_retention.sql`, `supabase/tests/070_retention.test.sql`

**Interfaces:**
- Produces:
  - `private.purge_expired() returns jsonb`, which returns counts `{messages, occupancy, reports, mod_actions}`. It deletes messages older than 15 min, occupancy with `last_seen` older than 90 s, reports with `handled_at` older than 90 days, and mod_actions older than 1 year.
  - A pg_cron job `coffeebreak-purge` that runs `select private.purge_expired()` every minute.
  - `public.delete_my_account() returns void`. It deletes the `auth.users` row, which cascades to the profile. If the profile was banned, it first inserts into `banned_github_ids(github_id_hash text pk, banned_at, reason)` with `encode(sha256(github_id::text::bytea), 'hex')`. `claim_nickname` raises `banned` for a user whose GitHub id hash is in that table.

- [ ] **Step 1: Write the failing tests:**
  - With rows at the boundary ages (14 min vs 16 min, 80 s vs 100 s, 89 vs 91 days, 364 vs 366 days), `purge_expired()` deletes only the older ones and returns the right counts.
  - `cron.job` has a row named `coffeebreak-purge` with schedule `* * * * *`.
  - `delete_my_account()` removes the profile. A banned user who deletes their account and signs up again with the same GitHub id hits `banned` on `claim_nickname`.
- [ ] **Step 2:** Run `bun run db:test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun run db:test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(db): retention jobs + account deletion`.

### Task 10: GitHub account age

**Files:**
- Create: `supabase/functions/github-age/index.ts`, `tests/integration/github-age.test.ts`

**Interfaces:**
- Produces: an Edge Function `POST /functions/v1/github-age` (requires the user JWT). It reads the caller's `github_id` from `profiles` with the service role, fetches `https://api.github.com/user/<github_id>`, and sets `profiles.github_created_at` from `created_at`. It returns `{github_created_at}`. Plan 2's helper calls it once after `claim_nickname`.

- [ ] **Step 1: Write the failing test.** Call the function for a user with `github_id = 583231` (GitHub's `octocat`) and assert that `github_created_at` = `2011-01-25T18:44:36Z`. Then call it for a user with no `github_id` and assert a 400 with `{"error":"no_github_id"}`.
- [ ] **Step 2:** Run `bunx supabase functions serve` in the background, then `bun test tests/integration/github-age.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Unauthenticated GitHub API calls are fine at beta scale (60 req/h per IP). Optionally use a `GITHUB_TOKEN` secret.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat: github-age edge function`.

### Task 11: Deploy to the hosted free-tier project

**Files:**
- Create: `docs/deploy.md` (the exact steps taken, with project ref and URLs but no secrets)

- [ ] **Step 1:** **Ask the owner before creating anything.** Then create the Supabase project `coffeebreak` on the free tier in the owner's organization (Supabase MCP `create_project`). Record the project ref.
- [ ] **Step 2:** Run `bunx supabase link --project-ref <ref>`, then `bunx supabase db push`. Expected: all 8 migrations applied. Verify with Supabase MCP `list_migrations`.
- [ ] **Step 3:** Run Supabase MCP `get_advisors` (security + performance). Expected: no security warnings for our tables or functions. Fix any that appear with a new migration and tests.
- [ ] **Step 4:** Owner action: create a GitHub OAuth app with callback `https://<ref>.supabase.co/auth/v1/callback`. Enable the GitHub provider in Supabase Auth with its client id and secret. Add redirect URLs `http://127.0.0.1:*/callback` and the future moderator site origin. Document this in `docs/deploy.md`.
- [ ] **Step 5:** Deploy the `github-age` function: `bunx supabase functions deploy github-age`.
- [ ] **Step 6:** Make the owner admin. After the owner logs in once (spike S3), run via MCP `execute_sql`: `update public.profiles set role = 'admin' where nickname = '<owner nick>'`.
- [ ] **Step 7:** Run the integration tests against the hosted project with `SUPABASE_URL`/keys from MCP `get_project_url`/`get_publishable_keys` and the service key from the dashboard. Skip `github-age` if rate-limited. Expected: PASS.
- [ ] **Step 8:** Run spike S3.
- [ ] **Step 9:** Commit with message `docs: deploy notes`.
