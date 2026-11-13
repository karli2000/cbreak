# Coffee Break, Plan 5: One person, several Claude sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the same GitHub account is on a break from several Claude Code sessions at once, finishing one session must not knock the others out of the room. Today it does: one session's `leave_room` deletes the shared occupancy row, and the others re-join with a visible "went back to work / joined the break" blip.

**Architecture:**
- `occupancy` stays one row per user, so every policy, count and moderation path is unchanged.
- A new table `occupancy_sessions (user_id, session_id, last_seen)` records which helper processes hold that row. Its rows cascade from `occupancy`.
- Each helper process sends a random per-process `session_id` with `join_room`, `heartbeat` and `leave_room`.
  - `join_room` keeps a caller who is already live in that room in the same instance.
  - `leave_room` removes only its own session. It deletes the occupancy row only when no other live session of the user remains.
- The new parameters default to `null`, which keeps today's behaviour, so the moderator site and older helpers keep working.

**Tech Stack:** Postgres (SECURITY DEFINER RPCs, pgTAP), Bun helper (`plugin/helper/room.ts`), committed helper bundle.

**Spec:** `docs/superpowers/specs/2026-11-11-coffeebreak-design.md` §4.5 ("One helper per Claude Code session. Presence is keyed by user id, so a person with two busy sessions appears once."). **Also read:** `CLAUDE.md` (architecture rules, database layout, Plugin and helper-runtime sections).

## Global Constraints

- **House RPC pattern:**
  - `SECURITY DEFINER`, `set search_path = ''`, fully qualified names.
  - Execute revoked from `public, anon` and granted to `authenticated`.
  - Errors are `raise exception '<code>'`.
- **Changing an RPC signature:** drop the old function and create the new one; don't add an overload. Re-apply revoke and grant.
- **Copy current bodies exactly** before changing them:
  - `join_room` and `leave_room` from `20261111000300_rooms.sql`;
  - `heartbeat` from `20261111000900_final_review_fixes.sql`;
  - `private.purge_expired` from `20261111000800_retention.sql`.
- **Liveness:**
  - A live session has `last_seen > now() - interval '90 seconds'`, the same rule as `occupancy`.
  - `purge_expired` deletes session rows older than 90 s. Its return value keeps exactly the keys `{messages, occupancy, reports, mod_actions}`, because `070_retention` asserts that object.
- **New table access:** `occupancy_sessions` has RLS on, no policies, all privileges revoked from `anon` and `authenticated`, and no grants. Only the SECURITY DEFINER functions touch it.
- **One room per user:** a second session joining a *different* room moves the shared row there, and the first session follows via its heartbeat topic switch (existing behaviour). This is documented, not prevented.
- **Helper session id:** `crypto.randomUUID()` once per helper process, sent with every `join_room`, `heartbeat` and `leave_room` call, including the shutdown leave and `/logout` / `/delete-account`.
- **Bundle and version:**
  - After the helper change, run `bun run helper:bundle` and commit the bundle.
  - Bump `plugin/.claude-plugin/plugin.json` `version` to `0.2.1`.
- **Hosted rollout (owner step):**
  - The migration must be on the hosted project before the new helper is used. A new helper against the old database gets "function not found" from `join_room`.
  - The owner pushes it together with the still-pending `20261113000100`.
- **Workflow:**
  - Test-first.
  - Keep `CLAUDE.md` current.
  - Commits end with a `Co-Authored-By:` trailer.
  - Never push or `db push`.

## Review Focus

1. **Session A leaves while B is still on its break.**
   - Expected: B keeps its room row, gets no `not_in_room`, and does not re-join.
   - Other people's helpers report no "left/joined" for the user.
   - → Task 2 integration test `a second helper of the same account survives the first one leaving`.
2. **Session B's helper crashed or lost its network** (stale session row), and A leaves.
   - Expected: the occupancy row goes away, so the person isn't shown in the room for 90 s after their last real session left.
   - → Task 1 pgTAP `leave with only stale other sessions deletes the row`.
3. **A helper or client calls the RPCs without a session id** (the moderator site, an older helper, a direct call).
   - Expected: exactly today's behaviour.
   - → Task 1 pgTAP `null session keeps the old behaviour`.
4. **The second session joins while the first sits in a fuller instance.**
   - Expected: the second session lands in the same instance, not in whatever instance `join_room` would pick for a newcomer.
   - → Task 1 pgTAP `a live caller keeps their instance on join`.
5. **A ban while two sessions are live.**
   - Expected: the occupancy row and every session row are gone, and both helpers get `kicked`.
   - → Task 1 pgTAP `ban removes the occupancy and all session rows`.

---

### Task 1: Session-aware room RPCs

**Files:**
- Create: `supabase/migrations/20261113000200_multi_session.sql`, `supabase/tests/110_multi_session.test.sql`
- Modify: `CLAUDE.md` (Database layout row, Client contract, Decisions)

**Interfaces:**
- **Table:** `public.occupancy_sessions`
  - Columns: `user_id uuid not null references public.occupancy(user_id) on delete cascade`, `session_id uuid not null`, `last_seen timestamptz not null default now()`.
  - Primary key: `(user_id, session_id)`.
  - Index on `(user_id, last_seen)`.
  - RLS on, no policies; `revoke all … from anon, authenticated`.
- **`public.join_room(room_slug text, session_id uuid default null) returns jsonb`.** Same result shape as today: `{room, instance, topic, here}`.
  - If the caller already has a **live** occupancy row in `room_slug`, keep that instance and refresh `last_seen`; skip the instance pick.
  - Otherwise behave as today.
  - When `session_id` is not null, upsert `(uid, session_id, now())` into `occupancy_sessions` after the occupancy upsert.
- **`public.heartbeat(session_id uuid default null) returns jsonb`.** Same behaviour and result as today.
  - On success, with a non-null `session_id`, upsert the session row with `now()`.
- **`public.leave_room(session_id uuid default null) returns void`.**
  - `session_id` null: today's behaviour. The occupancy row is deleted, and the session rows go with it by cascade.
  - Otherwise: delete that session row. Delete the occupancy row only if no other session of the caller has `last_seen > now() - 90 s`.
  - No error when there is no row (as today).
- **`private.purge_expired()`:** also `delete from public.occupancy_sessions where last_seen < now() - interval '90 seconds'`. Its return value is unchanged.

- [ ] **Step 1: Write the failing pgTAP tests** (`110_multi_session.test.sql`, helpers from `_helpers.psql`; a test room created inline):
  - `two sessions of one user share one occupancy row and instance`: join A, then join B → one `occupancy` row and two `occupancy_sessions` rows, with equal `topic`s.
  - `a live caller keeps their instance on join`:
    - Put the caller in instance 2 (insert their occupancy row directly), with instance 1 fuller.
    - `join_room(room, B)` → instance 2.
  - `leave of one session keeps the row while another is live`: A and B joined; `leave_room(A)` → the occupancy row exists and B's session row exists.
  - `leave of the last session deletes the row`: then `leave_room(B)` → no occupancy row and no session rows.
  - `leave with only stale other sessions deletes the row`: A and B joined, B's `last_seen` set to `now() - interval '2 minutes'` → `leave_room(A)` deletes the row.
  - `null session keeps the old behaviour`:
    - `join_room(room)` and `heartbeat()` work with no session rows created.
    - `leave_room()` with a live session row present deletes the occupancy row and, by cascade, the sessions.
  - `heartbeat with a session refreshes its last_seen`.
  - `ban removes the occupancy and all session rows`: two sessions, then an admin `mod_ban` → both tables are empty for the user.
  - `purge removes stale sessions and keeps the result keys`: a stale session row of a user whose occupancy is live → purged. The result has exactly the 4 keys.
  - `occupancy_sessions is not readable by authenticated`: `table_privs_are` with `authenticated` = no privileges and `anon` = no privileges.
- [ ] **Step 2:** Run `bun run db:test`: the new file fails (missing table and signatures).
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run `bun run db:test` and confirm everything passes. Then run `bun run test:int` and confirm earlier suites are unaffected, since the defaults keep old calls working (github-age's 4 failures without functions serve are known).
- [ ] **Step 5:** Update CLAUDE.md:
  - the Database layout row;
  - Client contract: send a per-process `session_id`, and one room per user;
  - add migration `20261113000200` to the Owner actions as a `db push --remote` that must happen before the new helper is used.
- [ ] **Step 6:** Commit `feat(db): several sessions of one account share a room`.

### Task 2: Helper sends its session id

**Files:**
- Modify: `plugin/helper/room.ts`, `plugin/helper/main.ts`, `plugin/helper/api.ts`, `tests/unit/room-reconnect.test.ts` (or a new `tests/unit/room-session-id.test.ts`), `tests/integration/helper-room.test.ts`, `plugin/dist/coffeebreakd.js` (rebuilt), `plugin/.claude-plugin/plugin.json`, `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1 signatures `join_room(room_slug, session_id)`, `heartbeat(session_id)`, `leave_room(session_id)`.
- Produces: `RoomSession` deps gain `sessionId: string`.
  - Every `join_room`, `heartbeat` and `leave_room` call passes `{ session_id: sessionId }`, alongside `room_slug` for `join_room`.
  - `main.ts` creates `const sessionId = crypto.randomUUID()` once and hands it to every `RoomSession` that `roomOf` creates.
  - The bare `leave_room` fallbacks in `main.ts` shutdown and `api.ts` (`/logout`, `/delete-account`) pass it too.

- [ ] **Step 1: Write the failing tests**
  - Unit (fake client): `join, heartbeat and leave send the session id`. The recorded rpc args include `session_id` equal to the id given in deps, on all three calls, including the re-join after `not_in_room`.
  - Integration (`helper-room.test.ts`): `a second helper of the same account survives the first one leaving`:
    - Start helpers A and B with the **same** user session (the same data dir is not needed; two `startHelper({ session })` calls are fine). Both `/join` `testRoom` → equal `topic`.
    - An observer user C joins `testRoom` through a third helper (`startHelper` with C's session, `/join`). A raw supabase-js client would see a Phoenix presence leave for A's connection even though B's remains; the helper only reports real leaves.
    - A `/leave`. Expectations:
      - The occupancy row of the user still exists (service role).
      - With `COFFEEBREAK_TICK_MS=1000` on B, B emits no second `joined` within 3 s.
      - B's `/send` works.
      - C's helper emits no `presence` event whose `left` contains the user's nickname within 3 s.
    - Then B `/leave` → no occupancy row.
  - Keep the existing `leave removes occupancy` test passing.
- [ ] **Step 2:** RED (unit: missing `session_id` args; integration: B re-joins or the row is gone).
- [ ] **Step 3:** Implement, then run `bun run helper:bundle` and bump the plugin version to `0.2.1`.
- [ ] **Step 4:** GREEN:
  - `bun run test:unit`, which includes the bundle freshness test;
  - `bun test tests/integration/helper-room.test.ts`, then the full `bun run test:int`;
  - `bun run test:mod`;
  - `bunx tsc --noEmit`.
- [ ] **Step 5:** Update CLAUDE.md: the Room session section (session id), the Owner actions ordering note, and the Release note. Commit `feat(helper): per-process session id keeps other sessions in the room`.

---

## Decisions this plan makes

- **Sessions in their own table:** a side table keeps the one-row-per-user `occupancy` model, so Realtime policies, `messages_select`, `room_counts`, `report_user` snapshots, `mod_ban` and the moderator site need no change. Session rows cascade from it.
- **Parameters default to null:** this keeps old callers working and avoids a coordinated cut-over.
- **Rejoin keeps the instance:** a live caller who joins again keeps their instance, so a second session never moves the first one.
