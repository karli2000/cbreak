# Coffee Break, Plan 3: Static moderator site

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static web app where moderators and admins sign in with GitHub and handle reports, watch rooms live, look up users, ban/unban, read the audit log, and (admins) manage roles, rooms and the word filter. Host it on Cloudflare Pages.

**Architecture:**
- A Vite + React single-page app in `site/`. It is built to plain HTML/JS/CSS and talks to Supabase directly with supabase-js in the browser. There is no server of its own.
- All security stays in Postgres: RLS for reads, role-checked `SECURITY DEFINER` RPCs for every action. The site holds only the public URL and anon key.
- One small migration adds three missing RPCs: a ban list, a staff list, and unbanning a GitHub id whose account was deleted.
- Code layout:
  - A typed data layer (`site/src/api.ts`, functions that take a `SupabaseClient`) is integration-tested against the local stack.
  - Screens are React components tested with `bun test` + happy-dom + Testing Library, against a fake data layer.

**Tech Stack:** React 19, Vite 7, TypeScript, `@supabase/supabase-js` v2, `bun test` with `@happy-dom/global-registrator` and `@testing-library/react`, Cloudflare Pages (`bunx wrangler pages deploy`).

**Spec:** `docs/superpowers/specs/2026-11-11-coffeebreak-design.md` §7 (and §6.5 roles, §6.7 retention). **Also read:** `CLAUDE.md` (backend rules, RPC list, decisions).

**Roadmap:** Plan 4 = packaging (compiled helper binaries, marketplace, README with privacy note) + friends beta.

## Global Constraints

- **Static only** [owner]: the build output is plain files. There are no server functions, no Pages Functions, and no service-role key anywhere in `site/`.
- **Backend:** the hosted URL `https://meioekkvutvrspfvqgye.supabase.co` and anon key come from `plugin/shared/backend.ts` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` override them for local dev and tests.
- **Auth:** GitHub via Supabase Auth, PKCE (`flowType: 'pkce'`, `detectSessionInUrl: true`, `persistSession: true`, `autoRefreshToken: true`), `redirectTo` = `window.location.origin + window.location.pathname`. The hosted JWT expiry is 900 s, so supabase-js refreshes on its own.
- **Access:**
  - A signed-in user whose `my_profile()` fails (`no_profile`) or whose role is `user` sees exactly `You're not a moderator.` and a Sign out button.
  - A banned staff member sees `Your account is banned.`
  - Neither user gets any other screen or data call.
  - The Admin tab is shown only to `admin`. The server enforces every rule anyway.
- **Roles and actions** (spec §6.5):
  - Moderator: delete message, mute (exactly 10, 60 or 1440 minutes), unmute, ban, resolve report (`dismissed` | `actioned`), look up a user.
  - Admin: everything a moderator can do, plus unban, set role, rooms, word filter, and unban a deleted account's GitHub id.
  - Staff act only on lower roles. The server raises `forbidden` otherwise.
- **Error copy:** RPC errors arrive as PostgREST 400 with `message = '<code>'`. Map them with `errorText(code)` in `site/src/copy.ts`; unknown codes show `Something went wrong (<code>).`
- **User content is text:** message bodies, reasons, nicknames and snapshots are rendered as React text children only. Never use `dangerouslySetInnerHTML`. Long words wrap (`overflow-wrap: anywhere`).
- **Retention facts the UI must state:**
  - Messages expire after 15 minutes. A report's snapshot is the record.
  - Resolved reports are kept 90 days; `mod_actions` 1 year.
- **Nickname colors:** the same `nickColor` as the mod (`plugin/hooks/lib/format.ts`), imported, not copied.
- **Hosting:**
  - Cloudflare Pages project `coffeebreak-mod`; default URL `https://coffeebreak-mod.pages.dev`. A custom domain is an owner choice later.
  - `site/public/_headers` sets the CSP and security headers.
- **Production changes need the owner:**
  - `bunx supabase db push --remote` for the new migration.
  - Dashboard redirect URLs.
  - `wrangler pages deploy`.
  - The plan lists them as owner steps (Task 8). Never run `bunx supabase config push`.
- **Workflow:**
  - Work test-first, and keep `CLAUDE.md` current in every task.
  - Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never push unless the owner asks.

## Review Focus

1. **A non-staff or banned person signs in.** They must see only the refusal text, and the app must call nothing but `my_profile`. → Task 3 test `refuses users and banned staff without loading data`.
2. **Acting on a report whose message already expired** (15 min). Delete gives `not_found`. Expected:
   - The person sees `That message is already gone (messages expire after 15 minutes).`
   - Mute/ban and resolve still work.

   → Task 4 test `expired message: delete explains, resolve still works`.
3. **A moderator acting on a peer or an admin** (`forbidden`). Expected: `You can't act on someone with the same or a higher role.` The buttons come back, and nothing else changes. → Task 6 test `forbidden action shows the rank message`.
4. **The site left open for hours** (900 s tokens, laptop sleep). Expected: calls keep working after refresh. If the session is truly gone (`not_authenticated`, a 401, or a JWT error), the app returns to the sign-in screen instead of failing silently. → Task 3 test `an expired session returns to sign-in`.
5. **Hostile chat content** in snapshots and live messages: `<img src=x onerror=alert(1)>`, a 280-char word, RTL text. It must render as inert, wrapping text. → Task 4 test `snapshot content renders as text`.

---

## File structure

```
supabase/migrations/20261112000100_moderator_site.sql   mod_list_banned, admin_list_staff, admin_unban_github_id (Task 1)
supabase/tests/090_moderator_site.test.sql              pgTAP (Task 1)
site/package.json, site/vite.config.ts, site/tsconfig.json, site/bunfig.toml, site/index.html   (Task 2)
site/test/setup.ts                 happy-dom registration + Testing Library cleanup (Task 3)
site/src/config.ts                 SUPABASE_URL/ANON_KEY with VITE_* overrides (Task 2)
site/src/supabase.ts               createSiteClient() (Task 2)
site/src/api.ts                    typed data layer, ApiError (Task 2)
site/src/copy.ts                   UI strings, errorText(code) (Task 2)
site/src/main.tsx, site/src/App.tsx, site/src/auth.tsx, site/src/nav.ts   shell, gate, hash tabs (Task 3)
site/src/components/ActionBar.tsx  reason + action buttons shared by screens (Task 4)
site/src/components/Snapshot.tsx   report snapshot / message lines (Task 4)
site/src/screens/Reports.tsx (4), Live.tsx (5), Users.tsx + Bans.tsx (6), Audit.tsx + Admin.tsx (7)
site/src/styles.css                plain CSS, light + dark via prefers-color-scheme (Task 3)
site/public/_headers               CSP + security headers (Task 8)
site/src/**/*.test.tsx             component tests (bun test, run from site/)
tests/integration/site-api.test.ts data layer vs the local stack (Task 2)
docs/moderator-site.md             build, deploy and owner steps (Task 8)
```

Root `package.json` scripts added in Task 2:
- `"site:dev": "cd site && bunx vite"`
- `"site:build": "cd site && bunx vite build"`
- `"test:site": "cd site && bun test"`

---

### Task 1: Backend RPCs for the site

**Files:**
- Create: `supabase/migrations/20261112000100_moderator_site.sql`, `supabase/tests/090_moderator_site.test.sql`
- Modify: `CLAUDE.md` (Database layout table, Known limitations)

**Interfaces:**
- Produces (all `SECURITY DEFINER`, `set search_path = ''`, execute revoked from `public, anon`, granted to `authenticated`):
  - `public.mod_list_banned() returns table(id uuid, nickname text, banned_at timestamptz, ban_reason text)`
    - Guarded by `private.require_rank_over(null, 'moderator')`.
    - Returns profiles with `banned_at is not null`, ordered by `banned_at desc`, limit 500.
  - `public.admin_list_staff() returns table(id uuid, nickname text, role public.app_role)`
    - Guarded by `require_rank_over(null, 'admin')`.
    - Returns profiles with `role <> 'user'`, ordered by `role desc, nickname`.
  - `public.admin_unban_github_id(github_id bigint, reason text) returns void`
    - Guarded by `require_rank_over(null, 'admin')`.
    - Deletes the `banned_github_ids` row whose hash is `encode(sha256(convert_to(github_id::text,'UTF8')),'hex')`; raises `not_found` if no row was deleted.
    - Writes one `mod_actions` row via `private.log_action(null, 'admin_unban_github_id', reason, jsonb_build_object('github_id_hash', <hash>))`. Check `private.log_action`'s signature in `20261111000600_moderation.sql`.
    - Reason is cleaned and cut to 500 chars, as in the other mod RPCs.

- [ ] **Step 1: Write the failing pgTAP tests** in `090_moderator_site.test.sql`, using `tests.create_user`, `tests.login_as`, `throws_ok(sql,'P0001','<code>')`:
  - `mod_list_banned`:
    - A user gets `forbidden`.
    - A moderator sees a banned user's `nickname` and `ban_reason`, and not an unbanned one.
    - A banned moderator gets `banned`.
  - `admin_list_staff`:
    - A moderator gets `forbidden`.
    - An admin sees exactly the moderator and admin rows (`role` included) and no plain user.
  - `admin_unban_github_id`:
    - A moderator gets `forbidden`.
    - An admin, after inserting the hash for github id `4242` into `banned_github_ids` (as superuser in the test), unbans it. The row is gone and one `mod_actions` row exists with action `admin_unban_github_id` and the hash in `details`.
    - A second call raises `not_found`.
    - Afterwards, a new auth user with github id `4242` can `claim_nickname`. Use `tests.create_auth_user(4242)` + `login_as`.
- [ ] **Step 2:** Run `bun run db:test` and confirm the new file FAILS (functions missing).
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run `bun run db:test`: all pgTAP tests pass (237 earlier + new).
- [ ] **Step 5:** Update CLAUDE.md:
  - Add a row to the Database layout table.
  - Known limitations: remove the "needs SQL" line about lifting a deleted account's ban, and point to `admin_unban_github_id`.
  - Add the new RPCs to the "Next up" owner list as "needs `db push --remote` (owner)".
- [ ] **Step 6:** Commit `feat(db): moderator site RPCs (ban list, staff list, unban by GitHub id)`.

### Task 2: Site scaffold, config, data layer

**Files:**
- Create: `site/package.json`, `site/vite.config.ts`, `site/tsconfig.json`, `site/bunfig.toml`, `site/index.html`, `site/src/config.ts`, `site/src/supabase.ts`, `site/src/api.ts`, `site/src/copy.ts`, `tests/integration/site-api.test.ts`, `site/src/copy.test.ts`
- Modify: root `package.json` (scripts), `.gitignore` (`site/node_modules`, `site/dist`), root `tsconfig.json` (exclude `site`), `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1 RPCs; existing RPCs and tables listed in CLAUDE.md; `SUPABASE_URL`/`SUPABASE_ANON_KEY` from `plugin/shared/backend.ts`.
- Produces:
  - In `site/src/config.ts`: `config: { url: string; anonKey: string }`, where `import.meta.env.VITE_SUPABASE_URL ?? SUPABASE_URL` (same for the key).
  - In `site/src/supabase.ts`: `createSiteClient(): SupabaseClient` (auth options per Global Constraints).
  - In `site/src/copy.ts`:
    - `COPY` with at least: `notModerator: "You're not a moderator."`, `banned: 'Your account is banned.'`, `signIn: 'Sign in with GitHub'`, `signOut: 'Sign out'`, `expiredMessage: 'That message is already gone (messages expire after 15 minutes).'`, `retention: 'Chat messages expire after 15 minutes; the snapshot is the record.'`, `reasonRequired: 'A reason is required.'`.
    - `errorText(code: string): string` mapping:
      - `forbidden` → `You can't act on someone with the same or a higher role.`
      - `not_found` → `Not found.`
      - `banned` → COPY.banned
      - `invalid_duration` → `Mute for 10, 60 or 1440 minutes.`
      - `invalid_pattern` → `That is not a valid pattern.`
      - `not_authenticated` → `Your session ended. Please sign in again.`
      - `network` → `Can't reach the server. Check your connection.`
      - anything else → `Something went wrong (<code>).`
  - In `site/src/api.ts` (every function takes `c: SupabaseClient` first and throws `ApiError`):
    ```ts
    export class ApiError extends Error { code: string }
    export type Role = 'user' | 'moderator' | 'admin'
    export type Me = { id: string; nickname: string; role: Role; banned: boolean }
    export type SnapshotLine = { id: number; nickname: string; body: string; created_at: string; deleted?: true }
    export type Report = { id: number; reporter_id: string | null; target_id: string | null; message_id: number | null; room: string | null; instance: number | null; reason: string; snapshot: { message: SnapshotLine | null; context: SnapshotLine[] }; status: 'open' | 'dismissed' | 'actioned'; handled_by: string | null; handled_at: string | null; created_at: string }
    export type ModAction = { id: number; actor_id: string | null; target_id: string | null; action: string; reason: string | null; details: Record<string, unknown>; created_at: string }
    export type UserLookup = { profile: { id: string; nickname: string; role: Role; github_created_at: string | null; created_at: string; muted_until: string | null; banned_at: string | null; ban_reason: string | null }; reports_against: Omit<Report, 'target_id' | 'room' | 'instance'>[]; actions_against: Omit<ModAction, 'target_id'>[] }
    export type ChatMessage = { id: number; user_id: string | null; nickname: string; body: string; created_at: string }
    me(c): Promise<Me | null>                        // null on no_profile
    listReports(c, status: Report['status'], limit = 100): Promise<Report[]>   // newest first
    resolveReport(c, id: number, status: 'dismissed' | 'actioned'): Promise<void>
    deleteMessage(c, messageId: number, reason: string): Promise<void>
    mute(c, userId: string, minutes: 10 | 60 | 1440, reason: string): Promise<void>
    unmute(c, userId: string, reason: string): Promise<void>
    ban(c, userId: string, reason: string): Promise<void>
    unban(c, userId: string, reason: string): Promise<void>
    lookupUser(c, nickname: string): Promise<UserLookup>
    listBanned(c): Promise<{ id: string; nickname: string; banned_at: string; ban_reason: string | null }[]>
    unbanGithubId(c, githubId: number, reason: string): Promise<void>
    listActions(c, f: { action?: string; actorId?: string; targetId?: string; before?: string }, limit = 50): Promise<ModAction[]>  // created_at desc; before = created_at cursor
    names(c, ids: string[]): Promise<Map<string, { nickname: string; role: Role }>>  // public_profiles, one query
    roomCounts(c): Promise<{ room: string; instance: number; here: number }[]>
    recentMessages(c, room: string, instance: number, limit = 100): Promise<ChatMessage[]>  // oldest first
    watchRoom(c, room: string, instance: number, on: { message(m: ChatMessage): void; deleted(id: number): void; status(s: 'live' | 'error'): void }): () => void
    listRooms(c): Promise<{ slug: string; title: string; kind: string; lang: string | null; is_open: boolean }[]>
    upsertRoom(c, r: { slug: string; title: string; kind: string; lang: string | null; is_open: boolean }): Promise<void>
    listFilters(c): Promise<{ id: number; pattern: string; created_at: string }[]>
    addFilter(c, pattern: string): Promise<number>
    removeFilter(c, id: number): Promise<void>
    listStaff(c): Promise<{ id: string; nickname: string; role: Role }[]>
    setRole(c, userId: string, role: Role): Promise<void>
    ```
  - Error mapping (`ApiError.code`):
    - A PostgREST error whose `message` matches `^[a-z_]+$` → that message.
    - A fetch/transport failure → `network`.
    - HTTP 401, or a JWT-expired message → `not_authenticated`.
    - Otherwise → `unknown`.
  - `watchRoom`:
    - Subscribes to `room:<room>:<instance>` with `{ config: { private: true } }`. It never tracks presence, so staff watch invisibly.
    - Broadcasts: `message` → `on.message`, `deleted` → `on.deleted(payload.id)`.
    - `SUBSCRIBED` → `status('live')`; `CHANNEL_ERROR`/`TIMED_OUT` → `status('error')`.
    - Returns an unsubscribe that removes the channel.

- [ ] **Step 1:** Scaffold:
  - `site/package.json` with deps `react`, `react-dom`, `@supabase/supabase-js`, and dev deps `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom`, `@happy-dom/global-registrator`, `@testing-library/react`, `@testing-library/dom`. Run `cd site && bun install`.
  - `vite.config.ts` with the React plugin and `server.fs.allow: ['..']`, so `../plugin/shared` and `../plugin/hooks/lib/format.ts` import cleanly.
  - `index.html` with `<title>Coffee Break moderation</title>`.
- [ ] **Step 2: Write the failing tests**
  - `copy.test.ts`: `errorText('forbidden')`, `errorText('not_authenticated')` and `errorText('zzz')` → `Something went wrong (zzz).`
  - `tests/integration/site-api.test.ts` (local stack; `setup()`/`teardown()`, `userClient(nick, role)` from `_env.ts`):
    - `me returns the role and null without a profile`: `bareUser()` → null.
    - `listReports returns an open report with its snapshot`: A user reports B with a message id; a moderator's `listReports(c,'open')` contains it, and `snapshot.message.body` is equal.
    - `resolveReport moves it to dismissed`.
    - `mute and unmute through the api`: B's `muted_until` is set, then cleared (read with the service role).
    - `forbidden maps to ApiError code forbidden`: a moderator mutes another moderator.
    - `ban, listBanned, unban`: unban needs an admin; a moderator's `unban` gives `forbidden`.
    - `listActions filters by action and pages with before`.
    - `names resolves ids in one call`.
    - `lookupUser returns profile, reports and actions`.
    - `listStaff and setRole (admin)`.
    - `rooms and filters (admin)`: `upsertRoom` on `otherRoom` (from `setup()`) with a new title, then `listRooms` shows it; never touch `lobby`; `addFilter`, then `removeFilter`.
    - `watchRoom receives a message and a deletion`: a moderator watches the test room instance 1 while user A (joined) sends; `deleteMessage` then fires `deleted`.
    - `recentMessages returns the instance's messages oldest first`.
    - `transport failure maps to network`: a client built with URL `http://127.0.0.1:9`.
- [ ] **Step 3:** Run `bun run test:site` and `bun test tests/integration/site-api.test.ts`, and confirm both FAIL.
- [ ] **Step 4:** Implement `config.ts`, `supabase.ts`, `copy.ts`, `api.ts`. Add the scripts and the gitignore/tsconfig changes.
- [ ] **Step 5:** Run both test commands and confirm PASS. Run `bun run test:int` and confirm the earlier suites are unaffected (github-age needs functions serve).
- [ ] **Step 6:** Add a "Moderator site (Plan 3)" section to CLAUDE.md: layout, commands, data layer. Commit `feat(site): scaffold and data layer`.

### Task 3: App shell and sign-in gate

**Files:**
- Create: `site/test/setup.ts`, `site/src/main.tsx`, `site/src/App.tsx`, `site/src/auth.tsx`, `site/src/nav.ts`, `site/src/styles.css`, `site/src/fake-api.ts` (test helper), `site/src/App.test.tsx`
- Modify: `site/bunfig.toml` (`[test] preload = ["./test/setup.ts"]`), `site/src/api.ts` (add `Bound` and `bindApi`), `CLAUDE.md`

**Interfaces:**
- Consumes: `api.ts`, `copy.ts`, `createSiteClient`.
- Produces:
  - `type Api = typeof import('./api')`, without the client argument: the screens receive `api: Bound` where `Bound` = every api function with `c` pre-applied.
    - `bindApi(c: SupabaseClient): Bound` lives in `api.ts`.
    - Tests pass `fakeApi(overrides): Bound` from `fake-api.ts`. It records calls and returns canned data, and any call not overridden rejects with `ApiError('not_found')`.
  - `<App client={SupabaseClient} api={Bound} />`.
  - In `nav.ts`:
    - `type Tab = 'reports' | 'live' | 'users' | 'bans' | 'audit' | 'admin'`
    - `tabFromHash(hash: string, role: Role): Tab`: the default is `reports`; `admin` falls back to `reports` for non-admins.
  - `useOnAuthError(): (e: unknown) => void`: when the code is `not_authenticated`, it signs out and returns to the sign-in screen. Every screen passes caught errors through it.
- Gate states:
  - **Loading.**
  - **Signed out:** the `Sign in with GitHub` button runs `signInWithOAuth({ provider: 'github', options: { redirectTo } })`.
  - **Not moderator:** `COPY.notModerator` + Sign out.
  - **Banned:** `COPY.banned` + Sign out.
  - **Staff:** header `☕ Coffee Break moderation · <nickname> (<role>)`, tab bar (Reports, Live, Users, Bans, Audit, plus Admin for admins), the active screen, and Sign out.
- Styles: plain CSS. Light and dark through `prefers-color-scheme`, readable at 360 px wide, and `overflow-wrap: anywhere` on message text.

- [ ] **Step 1: Write the failing tests** in `App.test.tsx`. Use a fake client whose `auth.getSession`/`onAuthStateChange` return a chosen session.
  - `signed out shows the GitHub button`.
  - `refuses users and banned staff without loading data`:
    - `me` returns null → `You're not a moderator.`, and the fake api recorded only `me`.
    - Role `user` → same.
    - `banned: true` → `Your account is banned.`
  - `moderator sees the tabs without Admin; admin sees Admin`.
  - `hash selects the tab`: `#audit` → Audit active; `#admin` for a moderator → Reports.
  - `an expired session returns to sign-in`: a screen's api call rejects with `ApiError('not_authenticated')` → `auth.signOut` called and the GitHub button shows.
- [ ] **Step 2:** Run `bun run test:site` and confirm FAIL.
- [ ] **Step 3:** Implement. Screens are placeholders here (`<section aria-label="Reports">…`); Tasks 4–7 fill them in.
- [ ] **Step 4:** Run `bun run test:site` and confirm PASS. Then `bun run site:build` must succeed.
- [ ] **Step 5:** Update CLAUDE.md. Commit `feat(site): app shell and sign-in gate`.

### Task 4: Report queue

**Files:**
- Create: `site/src/components/ActionBar.tsx`, `site/src/components/Snapshot.tsx`, `site/src/screens/Reports.tsx`, `site/src/screens/Reports.test.tsx`
- Modify: `site/src/App.tsx` (mount), `CLAUDE.md`

**Interfaces:**
- Consumes: `Bound`, `Report`, `names`, `nickColor` (from `../../plugin/hooks/lib/format.ts`), `COPY`, `errorText`, `useOnAuthError`.
- Produces:
  - `<ActionBar target={{ userId: string; nickname: string }} messageId?: number | null onDone(): void actions={('delete' | 'mute' | 'ban' | 'unmute' | 'unban')[]} api={Bound} />`
    - One reason input (required for every action except delete, where it is optional).
    - Buttons: `Delete message`, `Mute 10m`, `Mute 1h`, `Mute 24h`, `Ban`, `Unmute`, `Unban`.
    - All buttons are disabled while a call runs. Errors show inline via `errorText`.
    - `not_found` from delete shows `COPY.expiredMessage`.
    - `Ban` asks for a second click (`Confirm ban`) within 5 s.
  - `<Snapshot snapshot={Report['snapshot']} highlightId={number | null} />`: context lines, the reported line highlighted, `(deleted)` marked, colored nicknames, and `COPY.retention` as a footnote.
- Reports screen:
  - A filter for Open / Dismissed / Actioned (default Open) and a list, newest first.
  - Each item shows reporter → target nicknames (via `names`; a deleted account shows `deleted user`), reason, room·instance, age, and the Snapshot.
  - Open items get an ActionBar (delete/mute/ban) plus `Dismiss` and `Mark actioned` buttons (`resolveReport`).
  - After any action the list reloads. A resolved report leaves the Open list.

- [ ] **Step 1: Write the failing tests** (`fakeApi`):
  - `lists open reports with names and snapshot`.
  - `dismiss resolves and removes the item`: `resolveReport(id,'dismissed')` called.
  - `expired message: delete explains, resolve still works`:
    - `deleteMessage` rejects `not_found` → `COPY.expiredMessage` shown.
    - `Mark actioned` still calls `resolveReport(id,'actioned')`.
  - `mute 1h needs a reason`:
    - An empty reason → `A reason is required.`, no call.
    - With a reason → `mute(target, 60, reason)`.
  - `ban asks for confirmation`: the first click shows `Confirm ban` with no call; the second click calls `ban`.
  - `buttons are disabled while a call runs`: hold the promise; two clicks → one call.
  - `snapshot content renders as text`:
    - A body `<img src=x onerror=alert(1)>` appears as text, and the container has no `img` element.
    - A 280-char single word is present, and its element has the class that sets `overflow-wrap: anywhere`.
- [ ] **Step 2:** Run `bun run test:site` and confirm FAIL. **Step 3:** Implement. **Step 4:** Confirm PASS.
- [ ] **Step 5:** Commit `feat(site): report queue`.

### Task 5: Live room view

**Files:**
- Create: `site/src/screens/Live.tsx`, `site/src/screens/Live.test.tsx`
- Modify: `site/src/App.tsx`, `site/src/fake-api.ts` (a controllable `watchRoom`), `CLAUDE.md`

**Interfaces:**
- Consumes: `roomCounts`, `recentMessages`, `watchRoom`, `ActionBar`, `nickColor`.
- Behavior:
  - The instance list comes from `roomCounts()`: `lobby · 1 — 7 here`. It refreshes every 30 s and on a `Refresh` button.
  - Picking an instance loads `recentMessages(room, n)`, then `watchRoom(room, n, …)`. A status chip shows `live` or `connection problem`.
  - New messages append; `deleted` removes the line. The view keeps at most 300 lines.
  - Each line has a `⋯` button that opens the ActionBar for that message (delete / mute / ban, target = `user_id`). Lines with no `user_id` only allow delete.
  - Switching instance or leaving the tab calls the unsubscribe.
  - The screen tells the moderator they are invisible: `You are watching silently; people in the room don't see you.`

- [ ] **Step 1: Write the failing tests:**
  - `lists instances`.
  - `shows backlog then live messages`.
  - `deleted removes the line`.
  - `switching instance unsubscribes the old one`: the fake records unsubscribe calls.
  - `status error shows connection problem`.
  - `keeps 300 lines`.
  - `delete from a line calls deleteMessage with that id`.
- [ ] **Step 2–4:** RED, implement, GREEN (`bun run test:site`).
- [ ] **Step 5:** Commit `feat(site): live room view`.

### Task 6: User lookup and bans

**Files:**
- Create: `site/src/screens/Users.tsx`, `site/src/screens/Bans.tsx`, `site/src/screens/Users.test.tsx`, `site/src/screens/Bans.test.tsx`
- Modify: `site/src/App.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: `lookupUser`, `listBanned`, `unban`, `unbanGithubId`, `names`, `ActionBar`.
- **Users screen:**
  - A nickname search (trimmed, lowercased, leading `@` stripped) runs `lookupUser`.
  - It shows the profile:
    - nickname with color, role;
    - GitHub account age (`github_created_at`, or `unknown → slow mode`);
    - joined date;
    - mute state (`Muted until HH:MM, DD MMM` or `Not muted`);
    - ban state with reason.
  - Then reports against them (reason, status, date, expandable Snapshot), then actions against them (action, actor nickname, reason, date).
  - The ActionBar for that user offers mute/unmute/ban, and unban for admins only.
  - `not_found` → `No user with that nickname.`
- **Bans screen:**
  - `listBanned()` as a table: nickname, banned at, reason.
  - For admins, `Unban` per row (reason required). Moderators see the list without buttons.
  - For admins, an extra form `Unban a deleted account by GitHub id` (numeric id + reason) runs `unbanGithubId`. `not_found` → `That GitHub id is not banned.`

- [ ] **Step 1: Write the failing tests:**
  - `lookup shows profile, reports and actions`.
  - `lookup normalizes @Nick`: `lookupUser('nick')`.
  - `unknown nickname shows the message`.
  - `forbidden action shows the rank message`: `mute` rejects `forbidden` → the exact `errorText('forbidden')` text, and the buttons are enabled again.
  - `moderators see bans without unban buttons; admins can unban with a reason`.
  - `unban by GitHub id validates the number`: `abc` → `Enter a numeric GitHub id.`, no call; `4242` + reason → `unbanGithubId(4242, reason)`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5:** Commit `feat(site): user lookup and bans`.

### Task 7: Audit log and admin

**Files:**
- Create: `site/src/screens/Audit.tsx`, `site/src/screens/Admin.tsx`, `site/src/screens/Audit.test.tsx`, `site/src/screens/Admin.test.tsx`
- Modify: `site/src/App.tsx`, `CLAUDE.md`

**Interfaces:**
- Consumes: `listActions`, `names`, `listStaff`, `setRole`, `lookupUser`, `listRooms`, `upsertRoom`, `listFilters`, `addFilter`, `removeFilter`.
- **Audit:**
  - A table of `mod_actions`: time, actor (nickname, or `system` when `actor_id` is null, e.g. `auto_mute`), action, target nickname, reason, and details (as compact `key: value` text).
  - Filters: an action select (the distinct actions the backend writes: `mod_delete_message, mod_mute, mod_unmute, mod_ban, mod_resolve_report, admin_unban, admin_set_role, admin_upsert_room, admin_add_filter, admin_remove_filter, admin_unban_github_id, auto_mute`), actor nickname, and target nickname. Nicknames resolve to ids with `lookupUser`.
  - `Load more` pages with `before`.
  - Note: `Actions are kept for 1 year.`
- **Admin** (shown to admins only):
  - **Staff:** `listStaff`, a role select per row (`setRole`), and an `Add moderator` nickname field (`lookupUser`, then `setRole(id,'moderator')`).
  - **Rooms:** `listRooms` with editable title, kind, lang and is_open, a `Save` button per row, and a `New room` row. The slug is checked against `^[a-z0-9-]{2,32}$` before the call.
  - **Word filter:** `listFilters`, `Remove` per row, and an `Add pattern` field. `invalid_pattern` → `errorText`. Shows `Patterns are case-insensitive regular expressions.`

- [ ] **Step 1: Write the failing tests:**
  - `audit shows system for a null actor`.
  - `audit filter by action calls listActions with it`.
  - `load more passes before = last created_at`.
  - `admin sets a role`.
  - `add moderator looks up then sets moderator`.
  - `room slug is validated before saving`: `Bad Slug` → a message, no call.
  - `invalid pattern shows the error`.
  - `remove filter calls removeFilter`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5:** Commit `feat(site): audit log and admin`.

### Task 8: Headers, build, deploy docs, owner run

**Files:**
- Create: `site/public/_headers`, `site/src/headers.test.ts`, `docs/moderator-site.md`
- Modify: root `package.json` (`"site:deploy": "bun run site:build && bunx wrangler pages deploy site/dist --project-name coffeebreak-mod"`), `docs/deploy.md` (link), `CLAUDE.md` (owner actions, Next up → Plan 4)

**Interfaces:**
- `_headers` for `/*`:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://meioekkvutvrspfvqgye.supabase.co wss://meioekkvutvrspfvqgye.supabase.co; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

- [ ] **Step 1: Write the failing test** `headers.test.ts`:
  - It reads `public/_headers`.
  - The CSP contains `connect-src 'self' https://meioekkvutvrspfvqgye.supabase.co wss://meioekkvutvrspfvqgye.supabase.co`, `frame-ancestors 'none'` and `script-src 'self'`.
  - `nosniff` is present.
  - After `bun run site:build`, `dist/_headers` exists, and no file in `dist` contains `service_role` or the string `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] **Step 2:** RED. **Step 3:** Add `_headers` and the deploy script. **Step 4:** GREEN.
- [ ] **Step 5:** Write `docs/moderator-site.md`:
  - Local dev: `bun run site:dev` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` from `bunx supabase status`.
  - Build.
  - Deploy: `bunx wrangler login` once, then `bun run site:deploy`.
  - A custom domain is optional.
  - The owner steps, in order:
    1. `bunx supabase db push --remote` (applies `20261112000100_moderator_site.sql`).
    2. Supabase dashboard → Authentication → URL Configuration → Redirect URLs: add `https://coffeebreak-mod.pages.dev/**` and `http://localhost:5173/**`. Keep the existing entries.
    3. `bunx wrangler login`, then `bun run site:deploy`.
  - Then the owner checklist:
    - The owner, signed in as `karli2000` (admin), sees all tabs.
    - A non-staff GitHub account sees `You're not a moderator.`
    - The report queue shows a test report.
    - The live view shows a test message.
    - The audit log lists the actions just taken.
- [ ] **Step 6:** Run every suite: `bun run test:site`, `bun run test:unit`, `bun run db:test`, `bun run test:int`.
- [ ] **Step 7:** Commit `feat(site): security headers, deploy script and docs`.

---

## Decisions this plan makes (beyond the spec)

- **Framework:** React + Vite (spec §7 leaves this to the builder). Tabs use the URL hash, with no router, because static hosting needs no rewrite rules.
- **Tests:** one runner, `bun test`, with happy-dom for components, like the rest of the repo. No Vitest.
- **Shared code:** the site imports `plugin/shared/backend.ts` and the mod's `nickColor`, so the backend constants and colors exist once.
- **Live view:** staff watch rooms invisibly (no presence track).
- **Bans:** banning needs a confirming second click. Deleting a message does not, since it is reversible in effect (it expires in 15 min anyway) and frequent.
- **Unbanning deleted accounts:** a deleted, banned account is unbanned by numeric GitHub id through the new `admin_unban_github_id`, which closes the "needs SQL" known limitation.
- **Hosting:** Cloudflare Pages project `coffeebreak-mod` on its default `pages.dev` URL. A custom domain and a public imprint (spec §6.7) wait for a public launch.
