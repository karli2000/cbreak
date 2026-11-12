# Spike findings

## S1: mod pane

- **Setup:** `spikes/mod-pane/` (see its README; removed after Plan 2, still in git history). Claude Code 2.1.322, WSL2.
- **Status:** owner run done 2026-11-12 08:12–08:14 (logs: spike.log, ticker.log). Owner: "everything worked".
- **Sources:** the types this build writes (`claude-code.d.ts`, 2.1.322) and code.claude.com/docs/en/plugins/mods/*.
- **Labels:**
  - *(from docs, not yet observed)* is what the docs or types say.
  - *(observed: `claude -p` smoke)* comes from two non-interactive runs: `claude -p "/coffee-spike"` and `claude -p "/coffee-spike ping"` with `--plugin-dir`.
  - *(observed: owner run)* is still to be filled in.

### 1. Does the pane open on its own at the owner's real terminal width?

- *(from docs, not yet observed)*
  - A pane the mod opens unasked, as from `turn.start` or a timer, is placed only at ≥144 columns. Once the user has opened that pane id themselves (in this or an earlier session), 110 columns is enough, "until they close the pane by hand".
  - Below that, `$.ui.open` resolves `{ isPlaced: false, reason }` and the pane waits, undrawn. It appears when the terminal gets wide enough or the user opens it.
  - An open that answers the user's own command or press is placed at any width.
  - A placed pane docks beside the transcript only in fullscreen rendering from 110 columns. Otherwise it sits inline above the prompt (`e.props.placement`).
- *(observed: `claude -p` smoke)* With no surface attached, `isPlaced: false` and the reason is `no-surface: no surface is attached ($.session.surfaces() is empty)`. Those runs reported 80 columns and not fullscreen.
- *(observed: owner run)*
  - Width: **100 columns** (fullscreen rendering).
  - Auto-placed? **No**: `isPlaced:false`, "unasked below 144 columns (100 now)". Opened by hand with `/coffee-spike`, then placed.
  - `dock` or `inline`? **inline** (above the prompt) at 89–102 columns.
  - Placed later once widened / 110 allowance: not tested.
  - **Owner feedback:** the pane did not keep the entry field in view; the owner had to scroll down to the Input by hand.

### 2. Does `turn.start` fire for queued prompts?

- *(from docs, not yet observed)* `turn.start` fires once per turn on the main loop, after `prompt.submit`. The docs describe a prompt typed during a turn as "folded into a running turn" (`session.append` rows, `$.ui.selection` notes). So a queued prompt may join the running turn without a new `turn.start`/`turn.complete` pair. `$.prompt.submit` by contrast "starts a turn of its own once the session is idle".
- *(observed: owner run)* **Confirmed: folded.** "hallo" was submitted while busy (`prompt.submit busy:true`) and produced no new `turn.start`; the one turn ended at 08:13:48. No pane flicker.

### 3. Does `turn.complete` fire with `isAborted` on Esc?

- *(from docs, not yet observed)*
  - Yes. It fires for a turn the user interrupted, with `e.isAborted === true` and `e.reason === 'aborted'`.
  - A hook that heard the start hears the end, and so does an aborted run.
  - Caveat from the docs: after an interrupt, "calls that start new work in the session are refused until the user's next input". Watch whether `$.ui.close` and `$.process.spawn` are affected.
- *(observed: owner run)* **Confirmed:** Esc gave `turn.complete` with `isAborted:true, reason:"aborted"`. The 5 s auto-close was requested (`ui.close.request`) but no `ui.close` followed and no error was logged, consistent with "new work refused after an interrupt until the next input". The owner closed the pane by hand later. **Plan 2 must not rely on auto-close after Esc**; retry the close on the next user input.

### 4. Does the spawned process die when the pane closes, on `/exit`, and when the terminal is closed?

- *(from docs, not yet observed)* From the types for `$.process.spawn`: "The loop is the child's life: leaving it, `return()` on the stream, `next.signal` aborting or the module unloading kills the child, and nothing else does, a hook's return included." So closing the pane kills the child only because the mod calls `return()` in its `ui.close` hook, which the spike does.
- *(observed: `claude -p` smoke)* When the `-p` session ended, the ticker got **SIGTERM** and exited. `ticker.log` shows `got SIGTERM`, then `exit`, and `pgrep` found nothing afterwards. Its Unix socket was cleaned up.
- *(observed: owner run)*
  - (a) auto-close after the turn: not observed (after Esc the close did not happen, see Q3).
  - (b) close mark: **child killed cleanly**: `ui.close origin:person`, then `spawn.stop`, ticker `got SIGTERM`, `exit code=0`.
  - (c) `/exit`: the pane was already closed; `session.end reason:prompt_input_exit` with no ticker running. Not tested with the pane open.
  - (d) terminal window closed: not tested.
  - (e) Ctrl+C twice: not tested.

### 5. Can the mod write to the spawned process's stdin? If not, is `$.http.fetch` to `http://127.0.0.1:<port>` allowed?

- *(from docs, not yet observed)*
  - **stdin: no.** `ProcessSpawnRequest.input` is one string that is written to stdin, and then stdin is closed. Without it, stdin is closed from the start. The types say "A string today; a later form may take the text in pieces". The stream returned by `spawn` only reads.
  - **`$.http.fetch`: allowed.** The types say "http or https, to whatever the host reaches, unless the organization's web-fetch policy refuses it". It also takes `socketPath` to go over a Unix socket. Every call is an `http.fetch` event, so another mod or an org policy can refuse it. Limits are 30 s per call and 4 MiB per body.
- *(observed: `claude -p` smoke)* `/coffee-spike ping` POSTed to the ticker over `http://127.0.0.1:<port>/say` and over `socketPath`. Both returned 200 in about 3 ms, and the ticker echoed both lines back on stdout to the pane's message list.
- *(observed: owner run, interactive)* **Confirmed:** 5 pane submits; every `fetch.tcp` and `fetch.unix` returned 200 in 1–8 ms and the echoes rendered.

### 6. Does typing in the Claude prompt ever leak into the pane Input, or the reverse?

- *(from docs, not yet observed)*
  - Keys reach a pane element only while it has focus. Esc hands the keys back to the prompt.
  - `$.ui.open({ focus: true })` is a request. It is granted only while the prompt has the keys over an empty composer.
  - The spike opens without focus on auto-open and with focus on `/coffee-spike`.
  - It redraws the Input once a second as a controlled field (`value` = last `onInput` text). Watch for lost keystrokes.
- *(observed: owner run)* No leak reported. No `prompt.submit` contained pane text, and the prompt-side "hallo" never produced `input.change`. No lost keystrokes reported.

### Verdict

**Go: mods are viable for Coffee Break.** Pane, Input, helper process and `$.http.fetch` to a localhost/Unix-socket bridge all work in the owner's WSL terminal.

Consequences for Plan 2:
1. **Narrow terminals are the norm** (owner: 100 columns). Auto-open never happens below 144 columns, so "toast + status hint + `/coffee` to open" is the *main* experience, not a fallback. Consider the `AbovePrompt` band as a compact alternative surface.
2. **Keep the entry field in view** (owner request): after every new message and on open, `$.ui.scroll({ in: <pane>, to: { key: <input key> }, block: 'end' })`. Added to the spike on 2026-11-12; the owner re-checks it.
3. **Per-user colors** (owner request): nickname color = FNV-1a hash of the lowercased nickname → hue, HSL(hue, 65%, 55%) as hex. Same name, same color for everyone; readable on dark and light themes. Added to the spike; the ticker now rotates nicknames (lena, yuki, ravi, max_k, bot).
4. Mod → helper: **no stdin**. Use `$.http.fetch` to the helper over a Unix socket (preferred) or a 127.0.0.1 port with a per-run secret.
5. Queued prompts fold into the running turn: one break per turn, as designed.
6. After Esc, auto-close is refused; close on the next user input instead.
7. Still unverified: whether the helper survives closing the terminal window or Ctrl+C twice. Plan 2's helper must also exit on its own when its parent goes away (watch `ppid` / stdout EPIPE).

## S3: GitHub login against the hosted project

- **Script:** `spikes/login/login.ts` (Bun; removed after Plan 2, still in git history). Supabase Auth PKCE, `signInWithOAuth({ provider: 'github', redirectTo: 'http://127.0.0.1:<random port>/callback', skipBrowserRedirect: true })`, local `Bun.serve` callback, browser opened via `powershell.exe Start-Process` on WSL, then `exchangeCodeForSession`.
- **Result (2026-11-12, owner run): works end to end.** user `karli2000`, GitHub id 675365. `claim_nickname`, `accept_rules` and the `github-age` function all succeeded (`github_created_at` 2011-03-17).
- **Random localhost port works** with the redirect allow-list entry `http://127.0.0.1:*/callback`.
- **`identity_data`** has `provider_id` (numeric GitHub id), `user_name`, `preferred_username`, `email`, `avatar_url`, `full_name`, `sub`, `iss`. **No account creation date**, so the `github-age` function is needed.
- **Tokens:** access token 3600 s, refresh token present. (hosted access token expiry is now 900 s, see docs/deploy.md)
- **Setup pitfalls hit during the run (document for the README):**
  1. The Client ID field must hold the app's Client ID (`Ov23li…` OAuth App / `Iv23li…` GitHub App), not the app name. Otherwise GitHub returns 404.
  2. The **Site URL** must be one real URL. The wildcard `http://127.0.0.1:*/callback` belongs only in **Redirect URLs**. A wildcard Site URL makes Auth fail with 500 `invalid port ":*"`.
  3. If a **GitHub App** (not a classic OAuth App) is used, it needs **Account permissions → Email addresses: Read-only**. Otherwise Auth fails with "Error getting user profile from external provider" (GitHub 403 on `/user/emails`).
- **Verdict:** the plan for `coffeebreakd login` holds as designed.

## Plan 2 owner run

- **Setup:** hosted backend, real GitHub account, Claude Code 2.1.322, the owner's normal WSL terminal (100 columns).
- **Run:** `bun run dev` from the repo root, i.e. `claude --plugin-dir plugin`. The mod starts the helper as `bun plugin/helper/main.ts`, so `which bun` must print a path.
- **Status:** run by the owner on 2026-11-12. Owner verdict: "everything seems to work". No per-item notes were given, so the result lines below record that overall verdict.

1. `/coffee setup`: the GitHub login opens in the Windows browser, the nickname check updates live while typing, the rules accept with `yes`, and the pane ends with "All set".
   - Result: works (owner verdict, 2026-11-12).
2. A long task (e.g. "count to 60 slowly using sleep 1 in bash, one number per call"): after 20 s, a toast or the status line shows `☕ N on break · /coffee to join` (at 100 columns).
   - Result: works (owner verdict, 2026-11-12).
3. `/coffee` opens the pane focused. The backlog shows, typing and sending works, and the input line stays in view as messages arrive.
   - Check explicitly: does the **first** `/coffee` of a break place the pane at 100 columns right away (it opens with `Joining the coffee room…`, then fills)? The mod opens it inside the command hook so it counts as asked; if it does not appear, note what the toast/status line says.
   - Result: works (owner verdict, 2026-11-12).
4. A second account (or a friend) sees the messages, with the same nickname colors.
   - Result: works (owner verdict, 2026-11-12).
5. When the task ends, the pane shows `Claude is done, back to work ☕` and closes after 15 s. With a draft typed, it stays open.
   - Result: works (owner verdict, 2026-11-12).
6. Esc mid-task: the pane may stay open, and the next prompt closes it.
   - Result: works (owner verdict, 2026-11-12).
7. Closing the terminal window mid-break: within about 60 s, `pgrep -af helper/main.ts` prints nothing.
   - Result: works (owner verdict, 2026-11-12).
8. Sleep and resume mid-break: start a long task, join the room, then suspend the laptop (or close the lid) for at least 2 minutes and wake it while the task still runs. The helper must not exit on wake (no `Coffee break stopped unexpectedly` line), the room comes back (a `Connection lost, reconnecting…` line followed by `Reconnected.` is fine), and after the task ends `/coffee status` still says `Signed in as …` (the login survived). Also check that a later, new session still starts signed in.
   - Result: works (owner verdict, 2026-11-12).
