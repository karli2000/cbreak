# Coffee Break

A Claude Code plugin that drops users into a shared group chat room while Claude is busy on their task, and takes them out when it's done. This repo holds the Supabase backend (built), plus later the helper `coffeebreakd`, the Claude Code mod/plugin, and a static moderator site.

- Design spec (the authority): `docs/superpowers/specs/2026-11-11-coffeebreak-design.md`
- Current plan: `docs/superpowers/plans/2026-11-11-coffeebreak-01-spikes-and-backend.md`
- Roadmap: Plan 2 = helper + Claude Code mod (after spikes S1/S3), Plan 3 = static moderator site (Cloudflare R2/Pages), Plan 4 = packaging + friends beta.

## Commands

```bash
bun run db:start   # start local Supabase stack (Docker); API 54321, DB 54322, Studio 54323
bun run db:reset   # re-apply all migrations
bun run db:test    # db reset + pgTAP tests (supabase/tests/*.test.sql)
bun run test:int   # bun test tests/integration (realtime/edge-function tests, needs running stack)
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

## Tests

- pgTAP files live at `supabase/tests/NNN_*.test.sql`. Each runs inside `begin … rollback` and loads helpers with `\ir _helpers.psql`.
- The helpers file is `_helpers.psql`, **not `.sql`**, so pg_prove doesn't run it as a test. It provides:
  - `tests.create_user(nick, role default 'user', github_age default '1 year') returns uuid`, which creates `auth.users` plus a profile with rules accepted
  - `tests.create_auth_user(gh_id)`, which creates an auth user with no profile
  - `tests.login_as(uid)` and `tests.logout()`
- Use `throws_ok(sql, 'P0001', '<code>')` for RPC errors.
- Work test-first: write the failing test, watch it fail (RED), implement, then confirm it passes (GREEN).

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
- `word_filter.pattern` must be a valid regex, enforced by a CHECK constraint, so one bad row can't break every send.

## Next up / owner actions

- Plan 1 remaining tasks:
  - Task 6: reports and auto-mute
  - Task 7: moderation RPCs
  - Task 8: realtime policies and integration tests
  - Task 9: retention
  - Task 10: `github-age` edge function
- Spike S1: the owner runs the mod-pane spike in their WSL terminal.
- Task 11: deploy to a new free-tier Supabase project `coffeebreak`. The owner approves creating it and sets up the GitHub OAuth app.
- Spike S3: GitHub login against the hosted project.
