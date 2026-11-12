# Coffee Break

A Claude Code plugin that drops users into a shared group chat room while Claude is busy on their task, and takes them out when it's done. This repo holds the Supabase backend (built), plus later the helper `coffeebreakd`, the Claude Code mod/plugin, and a static moderator site.

- Design spec (the authority): `docs/superpowers/specs/2026-11-11-coffeebreak-design.md`
- Current plan: `docs/superpowers/plans/2026-11-12-coffeebreak-02-helper-and-mod.md` (Plan 2). Done: `docs/superpowers/plans/2026-11-11-coffeebreak-01-spikes-and-backend.md` (Plan 1).
- Roadmap: Plan 2 = helper + Claude Code mod (after spikes S1/S3), Plan 3 = static moderator site (Cloudflare R2/Pages), Plan 4 = packaging + friends beta.

## Commands

```bash
bun run db:start   # start local Supabase stack (Docker); API 54321, DB 54322, Studio 54323
bun run db:reset   # re-apply all migrations
bun run db:test    # db reset + pgTAP tests (supabase/tests/*.test.sql)
bun run test:unit  # bun test tests/unit (plugin helper units, no stack)
bun run test:int   # bun test tests/integration (realtime/edge-function tests, needs running stack)
bunx supabase functions serve   # serve Edge Functions locally (Docker); needed for tests/integration/github-age.test.ts
```

The Supabase CLI is a dev dependency: always `bunx supabase …`, never a global `supabase`.
Local DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

## Architecture rules (do not break)

- **All logic lives in Postgres.** Tables have RLS. `anon` has no table access, and `authenticated` has SELECT only (filtered by RLS). Every write goes through a `SECURITY DEFINER` RPC with `set search_path = ''` and fully qualified names. Each RPC revokes execute from `public`/`anon` and grants it to `authenticated` only.
- **Clients never broadcast chat.** `send_message` inserts the row and broadcasts via `private.broadcast(topic, event, payload)`, which is the single wrapper around `realtime.send(..., private => true)`. Clients may only insert presence on `realtime.messages`, and that policy must require `extension = 'presence'`.
- **The nickname is server-side.** Messages copy the nickname from `profiles`, never from client input.
- **Schema `private`** holds internal helpers (`broadcast`, `is_valid_regex`, and later the rank guards and purge). It has no grants to `anon`/`authenticated`.
- **Errors** are `raise exception '<code>'` (SQLSTATE `P0001`) using the codes listed in the plan's Global Constraints, e.g. `banned`, `muted`, `rate_limited`, `too_long`, `empty`, `duplicate`, `filtered`, `not_in_room`, `nickname_taken`, `forbidden`.
- **`citext` is in schema `extensions`.** With `search_path = ''`, compare nicknames as `x::extensions.citext` or with `lower()`. Otherwise the comparison is case-sensitive.
- **Never store** prompts, code, file names or project data. The backend has no columns for them.

## Key values (from the spec)

- Message: 1–280 chars after cleaning. Bodies over 1120 raw chars are rejected before any regex runs. Stripped characters: C0, DEL, C1, bidi controls (U+202A–E, U+2066–9) and U+2028/9. Unicode whitespace is trimmed.
- Rate limits: ≥2 s between messages and ≤5 per 10 s. The same body within 60 s is `duplicate`. Young GitHub accounts (< 30 days, or unknown) get ≥10 s between messages.
- Rooms split into instances of max **50** live people. Topic: `room:<slug>:<n>`. "Live" means `last_seen` within 90 s. `join_room` and the stale-row `heartbeat` take the per-room advisory lock `hashtext('room:' || slug)`.
- Nicknames: `^[a-z0-9_-]{3,20}$`, case-insensitive unique, with a reserved list. The first claim is free and the first rename is free; after that, at most one rename per 30 days.
- Auto-mute: 3 distinct reporters within 10 min mutes the user for 24 h. Mute durations are 10, 60 or 1440 minutes. Roles are `user` < `moderator` < `admin`, and staff can only act on users with a lower role.
- Retention: messages 15 min, resolved reports 90 days, `mod_actions` 1 year.

## Database layout

| Migration | Contents |
|---|---|
| `20261111000100_schema.sql` | Enums `app_role`, `report_status`. Tables `profiles`, `rooms` (seeds `lobby`), `occupancy`, `messages`, `reports`, `mod_actions`, `word_filter`. Functions `current_role_of`, `is_staff`, `is_admin`. View `public_profiles`. RLS and grants. |
| `20261111000200_profiles.sql` | `nickname_available`, `claim_nickname`, `accept_rules`, `my_profile` |
| `20261111000300_rooms.sql` | `join_room`, `heartbeat`, `leave_room`, `room_counts` |
| `20261111000400_send_message.sql` | Schema `private`, `private.broadcast`, `send_message` |
| `20261111000450_send_message_hardening.sql` | `private.is_valid_regex` plus the CHECK constraint on `word_filter.pattern`. Bidi and Unicode-whitespace handling, and the 1120-char pre-check. |
| `20261111000460_word_filter_grants.sql` | Grants `service_role` usage on schema `private` and execute on `private.is_valid_regex`, so inserts into `word_filter` pass the CHECK. |
| `20261111000500_reports.sql` | `private.clean_text` (shared control/bidi strip + Unicode trim; `send_message` uses it too), `report_user(target_nickname, message_id, reason) returns bigint` with snapshot and auto-mute |
| `20261111000550_reports_staff_exempt.sql` | `report_user` redefined: moderators and admins are exempt from auto-mute |
| `20261111000600_moderation.sql` | `private.require_rank_over(target, min_role)`, `private.log_action`. RPCs `mod_delete_message`, `mod_mute`, `mod_unmute`, `mod_ban`, `mod_resolve_report`, `mod_lookup_user`, `admin_unban`, `admin_set_role`, `admin_upsert_room`, `admin_add_filter`, `admin_remove_filter` |
| `20261111000650_moderation_fixes.sql` | `is_staff`/`is_admin` return false for banned users. `private.require_rank_over` raises `banned` for a banned caller. `mod_resolve_report` enforces rank over the report's target |
| `20261111000700_realtime_policies.sql` | RLS on `realtime.messages`: `room_members_read` (SELECT) and `room_members_presence` (INSERT, `extension = 'presence'` only). Both require a `room:%` topic, a non-banned caller, and the caller's occupancy topic = `realtime.topic()` or `is_staff()` |
| `20261111000750_realtime_policies_liveness.sql` | Drops and recreates both `realtime.messages` policies: the occupancy row must also be live (`last_seen > now() - 90 s`). Otherwise as 000700 |
| `20261111000800_retention.sql` | `banned_github_ids` (RLS on, no grants), `private.purge_expired()` plus pg_cron job `coffeebreak-purge` (every minute), `delete_my_account()`, `claim_nickname` and `admin_unban` redefined, indexes on `reports(reporter_id)`, `reports(target_id)`, `occupancy(room, instance, last_seen)`, sequences revoked from anon/authenticated |
| `20261111000900_final_review_fixes.sql` | `messages_select` policy replaced (live occupancy of the same room/instance or staff, never banned, never soft-deleted). `send_message`: `room_closed`, stale row → `not_in_room`, payload gains `user_id`. `heartbeat`: `room_closed`. `report_user`: target from the message when `message_id` is given. `mod_ban`: `kicked` payload is `{user_id}` |

## Edge Functions

- `supabase/functions/github-age/index.ts`: `POST /functions/v1/github-age` (verify_jwt default true, no config.toml entry). Resolves the caller via `auth.getUser(token)`, then with a service-role client reads `profiles.github_id` and sets `github_created_at` from `https://api.github.com/user/<id>`; returns `{github_created_at}`. Idempotent (an already-set value is returned without calling GitHub). Errors: 401 `unauthorized`, 400 `no_profile` / `no_github_id` / `github_user_not_found`, 502 `github_unavailable`. Sends `User-Agent: coffeebreak`; the `GITHUB_TOKEN` secret (set on the hosted project 2026-11-12, fine-grained token, expires; renew it) raises the rate limit (60 req/h per IP unauthenticated). Plan 2's helper calls it once after `claim_nickname`.

## Tests

- pgTAP files live at `supabase/tests/NNN_*.test.sql`. Each runs inside `begin … rollback` and loads helpers with `\ir _helpers.psql`.
- The helpers file is `_helpers.psql`, **not `.sql`**, so pg_prove doesn't run it as a test. It provides:
  - `tests.create_user(nick, role default 'user', github_age default '1 year') returns uuid`, which creates `auth.users` plus a profile with rules accepted
  - `tests.create_auth_user(gh_id)`, which creates an auth user with no profile
  - `tests.login_as(uid)` and `tests.logout()`
- Use `throws_ok(sql, 'P0001', '<code>')` for RPC errors.
- Work test-first: write the failing test, watch it fail (RED), implement, then confirm it passes (GREEN).
- Integration tests (`tests/integration/*.test.ts`, `bun test`) run against the live stack. `_env.ts` reads URL/keys from `bunx supabase status -o json`, or from `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` when all three are set (hosted runs). It exports `adminClient()`, `userClient(nick, role?)` (email user `<nick>_<runId>@test.local`, nickname `<nick>_<runId>`, rules accepted, role set via service role), `cleanup()` (remove channels, delete users; throws if a delete fails), `setup()`/`teardown()` and `warmUpRealtime()`.
- **Remote guard:** `_env.ts` refuses any URL whose host isn't `127.0.0.1`/`localhost`/`::1` unless `INTEGRATION_ALLOW_REMOTE=1`, and logs `integration target: <url>` once per run.
- **Dedicated rooms:** tests never touch `lobby` or other real rooms. `setup()` (in `beforeAll`) creates `itest-<runId>` (`testRoom`) and `itest-<runId>-b` (`otherRoom`) via the service role, then warms Realtime up. `teardown()` (in `afterAll`, and on a failed `setup()`) deletes leftover users, then the rooms' occupancy, messages and rooms. Created users are tracked module-wide, so users from a failed hook are still deleted.
- Channels: `client.channel(topic, { config: { private: true, presence: { key: userId } } })`. An unauthorized join comes back as `CHANNEL_ERROR` only after ~5 s, so integration tests use a 20 s timeout.

## Workflow

- Branch: `main`. Remote `origin` = github.com/karli2000/coffeebreak. **Don't push unless the owner asks.**
- Commits end with a `Co-Authored-By:` trailer.
- Build plans are executed task-by-task with subagents (superpowers subagent-driven-development). Progress and rulings are logged in `.superpowers/sdd/<plan>/progress.md`, which is git-ignored scratch.
- **Keep this CLAUDE.md up to date** whenever a task adds migrations, commands, conventions or decisions.

## Decisions made during the build (beyond the spec)

- Test helpers are in `_helpers.psql` (see Tests).
- A first nickname claim doesn't count as a change.
- `heartbeat` on a stale row is refused (`not_in_room`) if its instance has refilled to 50, so the client re-joins. Banned users get `banned` from `heartbeat`.
- `E'hi\x1b[2Jthere'` is stored as `hi[2Jthere`. Control characters are stripped, but the printable remains of the escape sequence stay, and they are harmless without ESC.
- Bidi controls are stripped as well, which goes beyond the spec's "control characters".
- `word_filter.pattern` must be a valid regex, enforced by a CHECK constraint, so one bad row can't break every send. The CHECK runs with the inserting role's privileges, so `service_role` is granted `usage` on `private` and `execute` on `private.is_valid_regex`. Nothing on `private` goes to public, anon or authenticated.
- `report_user` check order: not_authenticated, no_profile, banned, empty/too_long (reason cleaned with `private.clean_text`), target lookup (`not_found`), `cannot_report_self`, message checks (`not_found` if purged or not the target's), `already_reported` — **superseded for the `message_id` case by migration 000900**: with a `message_id` the target is the message's author, and the nickname must match the author's current or the message's stored nickname (see "Final review" below) (same reporter+target within 10 min, any status). Snapshot context: up to 10 nearest messages within +-5 min in the message's room/instance, or the target's current instance's last 10 (empty if no occupancy). Soft-deleted lines are included with `"deleted": true`.
- Auto-mute: 3 distinct reporters in 10 min sets `muted_until = greatest(existing, now()+24h)` and logs one `auto_mute` (actor null, `details.report_ids`); skipped if already muted for 23h+. Moderators and admins are exempt (reports are filed, no mute, no `auto_mute` row). Reports are serialized per target by an advisory lock.
- Moderation rank rule: `private.require_rank_over(target, min_role)` raises `forbidden` unless the caller's role is at least `min_role` and strictly above the target's, so nobody can act on themselves and admins can't touch other admins. `not_found` for a missing target. Checks run before argument validation (a plain user gets `forbidden` first).
- Every mutating moderation/admin RPC writes exactly one `mod_actions` row (action = function name). `mod_lookup_user` is read-only and writes none. Reasons are cleaned and cut to 500 chars.
- `mod_delete_message`: `not_found` if missing or already deleted; author rank is checked (a null author needs only a moderator role). `mod_ban` broadcasts `kicked` to the target's topic before deleting occupancy, and skips it if the target isn't in a room. `mod_resolve_report` rejects status `open` with `forbidden`; re-resolving is allowed. `admin_add_filter` maps invalid regex (and the CHECK's 23514) to `invalid_pattern` and is idempotent on an existing pattern.
- Realtime authorization (Task 8): read and presence-write need the caller's current occupancy topic (or staff); banned users never pass. Client broadcasts are refused by RLS, and so is `realtime.send()` called as `authenticated`/`anon` (it is security invoker and inserts `extension = 'broadcast'`). Only `private.broadcast` (security definer) sends chat. `realtime` is not an exposed PostgREST schema and `pg_graphql` is off, so `realtime.send` is not reachable over HTTP anyway.
- Realtime caches the policy result per channel join (re-checked only on join or a new access token). A banned or room-switching user keeps an already-joined channel until it is closed; `mod_ban` sends `kicked` and the client must leave. A re-join is refused.
- After `db reset` Realtime starts replicating `realtime.messages` lazily on the first client connection, and a DB broadcast sent before that is lost. Integration tests warm up in `beforeAll` via `setup()`: a warm-up user joins `itest-<runId>` and sends until one message arrives, then is deleted. Right after `db reset` the Realtime container is still restarting (joins fail with `transport failure`), so the warm-up retries the subscribe within its 30 s budget.
- Realtime policies only count a live occupancy row (`last_seen` within 90 s, migration 000750), the same liveness rule as `join_room`/`room_counts`. Integration tests cover each branch: banned with occupancy, staff without occupancy, other room/instance, stale row.
- Banned staff lose all powers: `require_rank_over` raises `banned`, and `is_staff()`/`is_admin()` are false (so RLS reads of reports/mod_actions/word_filter return nothing). `mod_resolve_report` requires rank over the report's target (reports against moderators need an admin, reports against admins can't be resolved via this RPC).
- Retention (Task 9): `private.purge_expired()` returns `{messages, occupancy, reports, mod_actions}` counts. Reports are purged only when `status <> 'open'` and `handled_at` is older than 90 days, so open reports are kept. `delete_my_account()` works for banned users too. If the profile is banned and has a `github_id`, it stores `encode(sha256(convert_to(github_id::text,'UTF8')),'hex')` in `banned_github_ids` before deleting the `auth.users` row. A first `claim_nickname` raises `banned` if the GitHub id hash is on file. `admin_unban` also removes the hash. The cron migration unschedules a job of the same name first, so it can be re-run.

## Hosted project

- `coffeebreak`, ref `meioekkvutvrspfvqgye`, `eu-central-1`, free tier. The repo is linked (`bunx supabase link`). Deploy with `bunx supabase db push --remote` (needs the owner's OK: it changes production) and `bunx supabase functions deploy github-age`. Full notes: `docs/deploy.md`.
- **Never run `bunx supabase config push`**: auth (GitHub provider, Site URL, redirect URLs) is configured in the dashboard and would be overwritten.
- Owner account: `karli2000` (admin).
- Final review (migration 000900):
  - REST reads of `messages` mirror the realtime rule: `deleted_at is null`, caller not banned, and a live occupancy row (`last_seen` within 90 s) in the message's room/instance, or `is_staff()`. Nobody reads soft-deleted rows via REST; mod tools get context from report snapshots and `mod_lookup_user`.
  - `send_message` on a stale occupancy row raises `not_in_room` and does not revive it (no capacity check there); the client re-joins. The old 040 test that allowed a stale send now expects `not_in_room`.
  - `send_message` and `heartbeat` raise `room_closed` when the caller's room has `is_open = false` (checked right after the occupancy lookup, before the stale check).
  - `message` broadcast payload: `id, user_id, nickname, body, created_at, role`.
  - `report_user` with a `message_id`: the target is the message's author, accepted when `target_nickname` matches the author's current nickname or the nickname stored on the message (so renames still work and the new holder of an old name is never hit). Otherwise `not_found`. Without `message_id` the nickname path is unchanged. Check order: … empty/too_long, message + author lookup (`not_found`), `cannot_report_self`, lock, `already_reported`.
  - `kicked` payload is `{user_id}` only (no ban reason to the room). The banned client reads `ban_reason` via `my_profile()`.
  - `realtime.send` adds its own generated uuid `id` to any payload that lacks an `id` key, so `kicked` arrives as `{id, user_id}`.

## Known limitations

- A muted (not banned) user can clear a mute by deleting the account and signing up again with the same GitHub id (only bans are remembered via `banned_github_ids`).
- `admin_unban`'s hash removal is unreachable once a banned profile deleted itself. Lifting such a ban needs SQL: `delete from public.banned_github_ids where github_id_hash = …`. Plan 3 may add `admin_unban_github_id`.

## Client contract (for Plan 2)

- RPC errors come back as PostgREST 400 with `message = '<code>'`.
- Break start: `join_room(slug)`; subscribe to the returned `topic` only after it succeeds.
- `heartbeat()` about every 30 s. The token refresh every 15 min (hosted JWT expiry 900 s) re-checks the live-occupancy realtime policy.
- `not_in_room` from `heartbeat`/`send_message` → call `join_room` again and switch to its topic. `join_room` may move you to another instance, so don't call it on mere reconnects; re-subscribe to the topic `heartbeat` returns instead.
- `room_closed` → leave the room.
- `kicked` → act only if `payload.user_id` is yours, then read the reason via `my_profile()` (`ban_reason`).
- Break end: `leave_room()`.
- Presence is advisory. Names come from `public_profiles`, "N here" from `room_counts()`.

## Plugin (Plan 2, in progress)

- Layout: `plugin/shared/` (`protocol.ts` = wire types + `PROTOCOL_VERSION`, imports nothing because the Claude Code mod imports it; `backend.ts` = hosted URL and public anon key), `plugin/helper/` (`coffeebreakd`: `rpc.ts` `CoffeeError`/`codeOf`/`rpc`, `emit.ts` NDJSON emitter, `auth.ts` `AuthStore`/`ensureFreshSession`/`authState`/`createHelperClient`). The mod and its generated types (`plugin/.claude-plugin/types/`, git-ignored) come in later tasks.
- Data dir: `$COFFEEBREAK_DATA_DIR`, else `${XDG_CONFIG_HOME:-$HOME/.config}/coffeebreak` (mode 700). `auth.json` = `{version:1, session}` (mode 600, tmp+rename), lock = directory `auth.lock` (retry 100 ms up to 10 s, stale after 30 s).
- Env overrides: `COFFEEBREAK_SUPABASE_URL`, `COFFEEBREAK_SUPABASE_ANON_KEY`, `COFFEEBREAK_DATA_DIR`, `COFFEEBREAK_TICK_MS`, `COFFEEBREAK_IDLE_EXIT_MS`, `COFFEEBREAK_REFRESH_MARGIN_S`, `COFFEEBREAK_NO_BROWSER=1`.
- `ensureFreshSession` adopts the file's session instead of refreshing when it is fresh by the margin, or when its refresh token differs from the client's and it expires no earlier (another process already rotated it). Refresh tokens rotate, so a second refresh would break the first process.
- Unit tests: `bun run test:unit` (`tests/unit/`, no stack needed). `tests/integration/_env.ts` gains `bareUser()` (signed in, no profile).
- Helper process (Task 2): `bun plugin/helper/main.ts` (`main.ts` = env, lifecycle, tick; `api.ts` = `Ctx`, `routes`, `SIGNED_OUT_OK`, `Bun.serve({unix})`). Socket `${XDG_RUNTIME_DIR or tmpdir}/coffeebreak-<uid>/<pid>.sock` (dir 700), removed on exit. stdout = NDJSON events: `hello` first, then one `auth` (signed_out without a session; with one, `ensureFreshSession` then `authState`, and `github-age` once if ready and `github_created_at` is null, errors ignored).
- Requests: `POST <path>` with a JSON body on the socket. HTTP 200 + `{ok:true,data}` or `{ok:false,code,message?}`; unknown path/method 404, invalid JSON 400 `bad_request`. Every request calls `touch()` (idle timer). Routes outside `SIGNED_OUT_OK` (`/ping`, `/status`, `/login`) return `not_signed_in` without a session; with a session each request first runs `ensureFreshSession` (supabase-js would otherwise refresh outside our lock). Implemented: `/ping`, `/status` (room is `null` until Task 3), `/nickname/check`, `/nickname/claim` (then `github-age` if needed, emits `auth`), `/rules/accept`, `/logout` (leave, local signOut, clear auth.json), `/delete-account`.
- Lifecycle: tick every `COFFEEBREAK_TICK_MS` runs `ensureFreshSession` (a thrown `network` = retry next tick; a null result after a session emits `auth signed_out`). Shutdown on idle (`COFFEEBREAK_IDLE_EXIT_MS` without a request), `process.ppid` change (checked every 1 s), stdout EPIPE, SIGTERM/SIGINT/SIGHUP: `leave_room` whenever a session exists (3 s cap), stop server, remove socket, exit 0.
- Test helper: `tests/integration/_helper.ts` `startHelper({session?, env?})` (temp data dir, `waitFor`, `call`, `stop`), `cleanupHelpers()`.

## Next up / owner actions

- **Plan 1 is complete** (backend, deploy, spikes S1 and S3; see `spikes/FINDINGS.md`).
- Spike S1 outcome: mods are viable. The owner's terminal is 100 columns, so the pane never auto-opens (needs 144); the toast/status hint plus `/coffee` is the main path. Owner UI rules for Plan 2: the pane keeps the input line in view (auto-scroll); each nickname gets a stable color from a hash of the name; the room can **only be opened while Claude is busy**.
- Spike S3 outcome: GitHub login with PKCE and a random-port `127.0.0.1` callback works; pitfalls are in `spikes/FINDINGS.md`.
- Plan 2 is written (`docs/superpowers/plans/2026-11-12-coffeebreak-02-helper-and-mod.md`, 8 tasks: helper Tasks 1–4, mod Tasks 5–8). Next: execute it.
