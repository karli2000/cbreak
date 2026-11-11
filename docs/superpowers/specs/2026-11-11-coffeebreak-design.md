# Coffee Break: design

*Working name. Final name still open, see "Name ideas".*
*Date: 2026-11-11 · Status: draft for approval*

Notation: **[owner]** = decided by the project owner in conversation. **[my call]** = chosen by Claude while designing; the owner can override. **[builder]** = left to whoever builds it.

---

## 1. Intent: the why

Waiting for Claude Code to finish a task is dead time. You watch the output scroll for a bit, nothing interesting happens, and you drift off to another window. **[owner]**

Coffee Break turns that dead time into a short, low-stakes social moment. When Claude starts working on your task, you're dropped into a **group chat room** with people anywhere in the world whose Claude is also busy. When your task is done, you leave the room and get back to work. **[owner]** The crowd is always changing, nobody stays long, and the only thing everyone has in common is "my AI is busy". **[my call]**

**What success looks like [my call]:** you check the room during a long task, have a light exchange with a stranger, and go back to work without it having cost you focus or felt risky.

## 2. Goals, non-goals, anti-goals

**Goals**
- Join a shared, many-person room automatically while Claude is busy, and leave automatically when it's done. **[owner]**
- The chat lives in a pane beside Claude inside the terminal (mockup option B). **[owner]**
- A unique nickname per person, backed by a one-time GitHub login. **[owner]**
- Rate limits, user reports, and moderators/admins who ban people from their own web interface. **[owner]**
- The admin/moderator frontend is **static files only**, hostable on S3, R2, Cloudflare Pages or similar. **[owner]**
- Built on open source infrastructure: Supabase. **[owner]**

**Non-goals (v1) [my call]**
- No 1:1 / direct messages. It's a room, not a messenger.
- No long-term chat history or search.
- No file, image or code sharing.
- No mobile or standalone web chat client for regular users (moderators get the web UI).
- No support for Claude Code cloud sessions or Claude Desktop under WSL. Plugins don't load there.

**Anti-goals: failure even if it technically works [my call, informed by owner's concerns]**
- **Leaking anything about your work.** Prompts, code, file names, repo names and Claude's output must never leave the machine. Only what the user types into the chat is sent.
- **Stealing focus.** The pane must never grab keystrokes meant for Claude, and must never open for tasks that take a few seconds.
- **A room that turns toxic or spammy** with nobody able to act on it. (Owner's main worry: spam/abuse → rate limits, reports, moderators.)
- **Impersonation.** Nobody can appear under someone else's nickname.

## 3. How it works at a glance

```
 ┌─────────────── your machine ───────────────┐          ┌────────── Supabase (hosted) ──────────┐
 │ Claude Code                                │          │ Auth (GitHub OAuth)                    │
 │  └─ coffeebreak plugin                     │          │ Postgres: profiles, rooms, messages,   │
 │      ├─ mod module (register.js)           │  HTTPS   │   reports, mod_actions, word_filter    │
 │      │   pane UI · /coffee commands ·      │◄────────►│ RPC functions (send, report, mod ops)  │
 │      │   busy/idle detection               │          │ Realtime (websocket): broadcast +      │
 │      └─ helper process (coffeebreakd)      │◄────────►│   presence per room                    │
 │          websocket to Supabase Realtime    │   WSS    │ pg_cron: purge old messages            │
 └────────────────────────────────────────────┘          └────────────────────────────────────────┘
                                                                         ▲
                                         static moderator site (S3/R2) ──┘ HTTPS (supabase-js)
```

## 4. The Claude Code plugin

### 4.1 Why a plugin, not a plain skill
A Claude Code **skill** is just instructions that Claude reads. It can't run in the background or react when Claude starts and stops. Coffee Break is therefore a **Claude Code plugin** that bundles a **mod** (Claude Code's plugin UI layer, available from v2.1.287) plus a small helper program. **[my call, required by the platform]**

Relevant docs (checked 2026-11-11):
- Mods: https://code.claude.com/docs/en/plugins/mods/overview.md, `…/create.md`, `…/reference.md`, `…/interface.md`, `…/events.md`, `…/api.md`
- Plugin components & manifest: https://code.claude.com/docs/en/plugins/components.md, `…/manifest-reference.md`
- Marketplaces: https://code.claude.com/docs/en/plugins/create-marketplace.md
- Hooks: https://code.claude.com/docs/en/hooks.md

The mods API is new. The builder must check every API name against the generated types for the installed build (see `create.md#get-the-types-for-your-build`). It must not be trusted from this document or from memory.

### 4.2 Plugin layout [my call]
```
coffeebreak/
  .claude-plugin/plugin.json      # name, version, description
  hooks/hooks.json                # { "modules": ["./register.js"] }
  register.js                     # the mod: events, pane, commands, status line
  helper/                         # coffeebreakd: Realtime bridge + OAuth login
  skills/coffee/SKILL.md          # optional: lets users ask Claude "how do I use coffee break?"
```
Distributed through a plugin **marketplace** (a GitHub repo with `.claude-plugin/marketplace.json`). Users install with `claude plugin marketplace add <owner>/<repo>` then `claude plugin install coffeebreak@<marketplace>`.

### 4.3 Busy/idle detection: when you're "on break"
- **Start:** mod event `turn.start` for the main conversation. Ignore subagent turns (`agentId` set). **[my call]**
- **Minimum wait:** only join if Claude is still busy after **20 s** (configurable). Short tasks never open the pane. **[my call]**
- **Still busy:** permission prompts count as busy. The room stays open while Claude waits for you to approve something. **[my call]**
- **End:** mod event `turn.complete`, including `isAborted` (Esc interrupt). Also handle API-error stops (`StopFailure`) and `session.end`. **[my call]**
- **Leaving:** on end, the pane shows "Claude is done, back to work ☕" and leaves after a **15 s** grace period. If the pane input holds an unsent draft, it waits until the draft is sent or cleared. **[owner agreed to grace period]**
- **Queued prompts / back-to-back turns:** if a new turn starts during the grace period, stay in the room. **[my call]** (Docs don't say whether `turn.start` fires for queued prompts. The builder verifies this in spike 1.)

### 4.4 The pane [owner: option B]
- A mod **Pane** beside the transcript, titled `☕ coffee room · 7 here`, showing the message list, join/leave lines ("lena joined the break", "ravi went back to work"), and an **Input** at the bottom.
- **Never steals focus.** The pane only receives keys when it's focused, and focus can only be granted when the Claude prompt is empty. Esc returns to the Claude prompt. (Mods guarantee this. Don't work around it.)
- **Auto-open only when there's room.** Mods only auto-place a pane in terminals ≥144 columns, or ≥110 once the user has opened it once. Otherwise `$.ui.open` returns `isPlaced: false`. In that case show a toast/status hint: `☕ 7 on break · Ctrl+X C to join`. The exact key is **[builder]**.
- **On join:** show the last ~15 minutes of messages so you don't land in silence.
- **Status line** (mod `$.ui.status`, not the settings `statusLine`, which plugins can't set): `☕ 7 on break` while on break. **[my call]** When not on break, show nothing. This avoids holding a websocket open all day (see 6.6).
- In-pane commands: `/report <nick> <reason>`, `/me`, `/leave`, plus moderator commands `/mute`, `/ban`, `/del`. Selecting a message and pressing `r` reports it. **[my call]**
- `@nickname` mentions are highlighted in v1. A sound/terminal notification for mentions comes later. **[my call]**
- Mockup reference: `.superpowers/brainstorm/*/content/chat-placement.html`, option B.

### 4.4a Fallback if mods don't work out [my call]
If spike 1 shows the mod pane or helper spawning is unreliable, the fallback is a **standalone terminal client** (`coffeebreak` command, same helper underneath), opened by the plugin in a tmux split, a Windows Terminal split (`wt.exe sp`) or a new terminal window. In terminals narrower than the auto-place width, the toast + hotkey experience is acceptable for v1.

### 4.5 Helper process: coffeebreakd [my call]
Mods have no websocket or socket API. Their `$.http.fetch` is request/response only. So:
- The mod starts `coffeebreakd` with `$.process.spawn` when a break begins and stops it when the break ends.
- **Incoming:** coffeebreakd holds the Supabase Realtime connection (supabase-js) and writes one JSON object per line to stdout: `message`, `presence`, `deleted`, `kicked`, `error`. The mod reads that stream and re-renders.
- **Outgoing:** the mod sends messages by calling the Supabase RPC `send_message` directly with `$.http.fetch`, using the access token the helper exposes. Alternative: coffeebreakd listens on a random `127.0.0.1` port with a per-run secret and the mod posts to it. **[builder]**: pick after spike 1.
- coffeebreakd also performs `login` (section 5) and refreshes tokens.
- **Runtime:** TypeScript, shipped as **standalone compiled binaries** from v1 (e.g. `bun build --compile` for linux-x64/arm64, darwin-x64/arm64), because many Claude Code users use the native installer and have no Node. **[my call]**
- **Platforms in v1:** macOS, Linux, Windows via WSL. Native Windows is v1.1 (browser launch, token-file permissions and process kill differ there). **[my call]**
- One helper per Claude Code session. Presence is keyed by user id, so a person with two busy sessions appears once.

### 4.6 Privacy guarantee [my call, anti-goal]
The mod sees prompts and tool calls (it has to, to detect busy/idle), but **never sends them anywhere**. The only data that leaves the machine: the auth token, room name, chat text the user typed, and reports the user filed. This is stated in the README and enforced in code review.

## 5. Setup & configuration

### 5.1 First run: `/coffee setup` [owner: one-time login]
1. The pane opens with "Sign in with GitHub to join coffee break".
2. coffeebreakd starts a temporary `http://127.0.0.1:<port>/callback` listener and opens the browser at Supabase's GitHub OAuth URL (PKCE flow, `skipBrowserRedirect`). On WSL it opens the browser via `wslview`/`explorer.exe`. **[builder]** Supabase Auth doesn't support GitHub's device-code flow, so the localhost callback is needed. **[my call]**
3. The user clicks "Authorize". The code is exchanged and the refresh token is saved to `${CLAUDE_PLUGIN_DATA}/auth.json` with mode `600`. **[my call]**
4. **Pick a nickname** in the pane Input, with a live availability check. Rules: 3–20 chars, `[a-z0-9_-]`, case-insensitive unique, a reserved list (`admin`, `mod`, `claude`, `anthropic`, …). Names can be changed at most once per 30 days. **[my call]**
5. **Accept the room rules** (be kind, no spam, no sharing private/company data; moderators can remove you) and a link to the privacy note. **[my call]**
6. Done. A short "how it works" note is shown once.

Others see only the nickname, never the GitHub handle. **[my call; owner did not object]** The server stores the GitHub user id so bans stick.

### 5.2 Settings
Stored in `${CLAUDE_PLUGIN_DATA}/config.json`, which survives plugin updates. Changed via `/coffee config` (opens a settings view in the pane) or subcommands. **[my call]**

| Setting | Default | Command |
|---|---|---|
| nickname | chosen at setup | `/coffee name <new>` |
| room | `lobby` | `/coffee room <slug>` |
| min busy time before joining | 20 s | `/coffee config` |
| grace period after Claude finishes | 15 s | `/coffee config` |
| auto-open pane | on | `/coffee config` |
| enabled | on | `/coffee off` · `/coffee on` |

Other commands: `/coffee` (open the pane now, even when not busy, read-only if not on break **[my call]**), `/coffee status`, `/coffee logout`, `/coffee delete-account` (removes profile and personal data; ban records keep only the GitHub id hash so bans still stick). **[my call]**

## 6. Backend: Supabase [owner]

**Hosting & launch [owner]:** the owner's own Supabase account, **free tier**, for a **friends-only beta**. The owner's account also owns the GitHub OAuth app and the moderator site's domain. Move to a paid plan before a public launch, or when the beta hits the free tier's concurrent-connection cap. Free projects pause after about a week with no activity, so expect to unpause it during quiet stretches of the beta.

Hosted Supabase to start. Every part is open source (Realtime is Elixir/Phoenix, Auth is Go, plus Postgres), so it can be self-hosted later.

### 6.1 Tables [my call]
- `profiles`: `id` (= `auth.uid()`), `github_id`, `nickname` (citext unique), `role` (`user` | `moderator` | `admin`), `github_created_at`, `muted_until`, `banned_at`, `ban_reason`, `nickname_changed_at`, `created_at`.
- `rooms`: `slug`, `title`, `kind` (`public` | later `language`/`tool`/`private`), `lang`, `is_open`.
- `messages`: `id`, `room`, `user_id`, `nickname` (copied at send time), `body`, `created_at`, `deleted_at`, `deleted_by`. Purged after 15 min by pg_cron.
- `reports`: `id`, `reporter_id`, `target_id`, `message_id`, `room`, `reason`, `snapshot` (jsonb: reported message + ~10 surrounding lines, copied at report time because messages expire), `status` (`open` | `dismissed` | `actioned`), `handled_by`, `handled_at`.
- `mod_actions`: append-only audit log, recording who did what to whom, why, and when.
- `word_filter`: admin-editable blocked terms/patterns.

RLS on all tables. Users can read their own profile and public profile fields. Only moderators/admins can read `reports` and `mod_actions`.

### 6.2 Sending a message: server-authoritative [my call, important]
Clients **never** broadcast chat directly. They call `rpc('send_message', {room, body})`, a `SECURITY DEFINER` function that:
1. rejects banned/muted users;
2. applies rate limits (6.4) and the length limit;
3. applies the word filter;
4. inserts into `messages` with the nickname taken from `profiles`, so names can't be faked;
5. broadcasts to Realtime topic `room:<slug>` (via `realtime.send` / a broadcast trigger).

### 6.3 Realtime channels [my call]
- One **private** channel per room: `room:<slug>`. RLS on `realtime.messages`:
  - SELECT (receive): authenticated, not banned.
  - INSERT: **only `extension = 'presence'`**, so clients can track presence but can't broadcast chat.
- Presence key = user id. The displayed nickname is resolved from `profiles`, not trusted from the presence payload. **[builder]**: cache lookups.
- Moderation events (`deleted`, `kicked`) are broadcast on the same topic by the mod RPCs.

### 6.3a Room size: auto-split [my call]
A "room" is a **room family** (e.g. `lobby`) split into **instances** of at most **50 people** (`lobby:1`, `lobby:2`, …). On joining, the helper asks an RPC `pick_instance(room)` for the fullest instance that still has space, so conversations stay small and lively. A new instance opens when all are full; empty instances close. Realtime topic = `room:<slug>:<n>`, and `messages` carries the instance number. The moderator live view lists instances. The header shows "☕ lobby · 7 here".

### 6.4 Rate limits & anti-abuse [owner: rate limits; numbers are my call]
- 1 message / 2 s; burst ≤5 per 10 s; ≤280 chars; identical message within 60 s dropped.
- GitHub accounts younger than 30 days: slow mode (1 msg / 10 s). Account age is fetched once at signup from the GitHub API (`/user/{id}`) by a Supabase Edge Function or the client during setup. **[builder]**
- Auto-mute: 3 distinct reporters on the same user within 10 min → muted until a moderator reviews. **[my call]**
- Limits are checked in Postgres, so they can't be bypassed by a modified client.

### 6.5 Roles & moderation RPCs [owner: admins & moderators; details my call]
- **user**: chat, report.
- **moderator**: + `mod_delete_message`, `mod_mute(user, duration ∈ {10m,1h,24h}, reason)`, `mod_ban(user, reason)`, `mod_resolve_report`.
- **admin**: + `admin_set_role`, `admin_unban`, room management, word filter editing.
- Every mod/admin RPC checks the caller's role inside the function and writes to `mod_actions`.
- Banned users: their channel is kicked, the pane shows "You've been removed from coffee break: <reason>", and the plugin stops connecting.

### 6.6 Capacity note
Supabase plans cap concurrent Realtime connections. Check the current numbers for the chosen plan. Connecting **only while on break** (not all day) keeps usage proportional to how many people are actually waiting. If the cap is reached, the pane shows "The coffee room is full, try again in a minute". **[my call]**

### 6.7 Data retention & privacy [my call, GDPR-minded]
- Chat messages: 15 min. Reports and snapshots: 90 days after resolution. `mod_actions`: 1 year. Purged by pg_cron.
- Self-service account deletion (`/coffee delete-account`).
- A short privacy note (what's stored, why, how long) linked at setup and in the README. The operator's legal notice/imprint goes on the static site if launched publicly in the EU.

## 7. Moderator web interface [owner: static pages only]
- A **static single-page app** (Vite + a small framework, e.g. React or Svelte **[builder]**). It's built to plain HTML/JS/CSS and hosted on S3, Cloudflare R2/Pages, or any static host. **[owner]**
- It talks to Supabase with supabase-js from the browser: GitHub login → session → RLS + role-checked RPCs. No server of its own. Security lives entirely in the database (RLS + `SECURITY DEFINER` RPCs). The static site holds only the public Supabase URL and publishable key. **[my call]**
- Supabase Auth redirect URLs must include the site's domain.
- Non-moderators who log in see "You're not a moderator".

**Screens [my call]**
1. **Report queue**: snapshot, reporter, target, reason; buttons Dismiss / Delete message / Mute (10m/1h/24h) / Ban.
2. **Live room view**: watch a room in real time, delete messages inline.
3. **User lookup**: nickname, account age, join date, report history, past actions, current mute/ban.
4. **Bans**: list, unban (admins only).
5. **Audit log**: filterable `mod_actions`.
6. **Admin**: manage moderators, rooms, word filter.

## 8. Build order [my call]

**Spikes first (throwaway, to remove the big unknowns):**
1. **Mod spike** in the owner's real setup (WSL terminal): a pane with an Input, `turn.start`/`turn.complete`/`isAborted`, `$.process.spawn` streaming stdout into the pane, and auto-placement at different widths. Answers: queued-prompt behavior, mod↔helper send path, and whether the helper is killed cleanly on exit.
2. **Supabase spike**: private channel with a presence-only INSERT policy; `send_message` RPC broadcasting; verify a client can't broadcast directly.
3. **Login spike**: PKCE GitHub login with a localhost callback from WSL.

**Then:**
4. Database schema, RLS, RPCs, pg_cron purge, with SQL tests for limits and permissions.
5. coffeebreakd (login, connect, stream, refresh, reconnect with backoff).
6. Mod: lifecycle, pane, status, commands, config.
7. Reporting + in-pane moderator commands.
8. Static moderator site.
9. Packaging: marketplace repo, README with the privacy statement, install instructions.
10. Friends-only beta on the free tier; upgrade the Supabase plan before any public launch.

## 9. Open source building blocks
**Chosen:** Supabase (Postgres, GoTrue Auth, Realtime on Elixir/Phoenix, pg_cron), supabase-js, Vite.

**Alternatives considered** (in case Supabase is replaced or self-hosting gets serious):
- **Centrifugo**: standalone Go realtime server with presence, history and JWT auth. Very scalable; would need a separate auth/API service.
- **Phoenix Channels** (Elixir) or **Socket.IO** / **ws** (Node): roll your own server. Full control, more to build and operate.
- **Matrix** (Synapse / Conduit / conduwuit): a full chat protocol with moderation tooling and federation. Heavy for ephemeral rooms.
- **Ergo** (IRC server with websocket support and accounts): a nerdy, lightweight fit for "rooms with strangers".
- **PartyKit / Cloudflare Durable Objects**: room-per-object model. PartyKit is open source; Durable Objects are not.

## 10. Name ideas [my call; owner to pick]
Avoid "Claude" in the product name (it's Anthropic's trademark), though "for Claude Code" in a description is fine.

| Name | Command | Why |
|---|---|---|
| **Coffee Break** | `/coffee` | Exactly the idea; working name |
| **Brewing** | `/brew` | Plays on the "Brewing…"-style spinner while Claude works |
| **Breakroom** | `/breakroom` | Office feel, self-explanatory |
| **Water Cooler** | `/cooler` | Classic office small talk |
| **Loading Lounge** | `/lounge` | You're here because something is loading |
| **Idle Hands** | `/idle` | Cheeky |
| **Spinner Lounge** | `/spin` | Named after the thing you'd otherwise stare at |
| **Compile & Chill** | `/chill` | Developer humor |

Recommendation: **Coffee Break** with `/coffee`. It's instantly understood and already the folder name.

## 11. Future extensions [my call; not in v1]
- **Language rooms**: `lobby-de`, `lobby-es`, …; default chosen from config or system locale, with an option to stay in the global lobby. (Owner's example.)
- **Tool/stack rooms**: rooms by stack (`#rust`, `#python`, `#frontend`), opt-in. Optional auto-suggestion from project files, computed locally; nothing about the project is sent, only the chosen room.
- **Private team rooms**: invite-code rooms for a company or friend group (`room_members` + RLS).
- **Opt-in "what I'm waiting on" badge**: e.g. "running tests · 4m". Only from a fixed list the user picks, never auto-derived from prompts.
- **Wait timer & fun stats**: "you've waited 3h this week", longest-wait-of-the-day.
- **Reactions**, and a sound/terminal notification on @mention.
- **Mini-games while waiting**: trivia, ASCII tic-tac-toe with someone in the room.
- **Message translation**: show messages in your language (LLM, opt-in).
- **More clients**: VS Code chat panel (mods support it), other coding agents (Codex CLI, Gemini CLI) via a standalone terminal client.
- **Self-hosting kit**: docker-compose with self-hosted Supabase plus the static moderator site.
- **Bridges**: Matrix/IRC bridge for people who want to hang around after their break.

## 12. Left to the builder
- Exact mods API usage, verified against generated types.
- The mod→helper send path (direct RPC vs localhost bridge), decided after spike 1.
- Frontend framework for the moderator site; visual design of pane and site.
- Reconnect/backoff strategy, logging, error copy.
- Keybinding for opening the pane.
- SQL test approach and CI setup.
