# Spike findings

## S1: mod pane

- **Setup:** `spikes/mod-pane/` (see its README). Claude Code 2.1.322, WSL2.
- **Status:** built and validated. Waiting for the owner's interactive run.
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
  - Width (`tput cols`):
  - Auto-placed?
  - `dock` or `inline`?
  - Placed later once widened?
  - 110 allowance after a manual open?

### 2. Does `turn.start` fire for queued prompts?

- *(from docs, not yet observed)* `turn.start` fires once per turn on the main loop, after `prompt.submit`. The docs describe a prompt typed during a turn as "folded into a running turn" (`session.append` rows, `$.ui.selection` notes). So a queued prompt may join the running turn without a new `turn.start`/`turn.complete` pair. `$.prompt.submit` by contrast "starts a turn of its own once the session is idle".
- *(observed: owner run)*

### 3. Does `turn.complete` fire with `isAborted` on Esc?

- *(from docs, not yet observed)*
  - Yes. It fires for a turn the user interrupted, with `e.isAborted === true` and `e.reason === 'aborted'`.
  - A hook that heard the start hears the end, and so does an aborted run.
  - Caveat from the docs: after an interrupt, "calls that start new work in the session are refused until the user's next input". Watch whether `$.ui.close` and `$.process.spawn` are affected.
- *(observed: owner run)*

### 4. Does the spawned process die when the pane closes, on `/exit`, and when the terminal is closed?

- *(from docs, not yet observed)* From the types for `$.process.spawn`: "The loop is the child's life: leaving it, `return()` on the stream, `next.signal` aborting or the module unloading kills the child, and nothing else does, a hook's return included." So closing the pane kills the child only because the mod calls `return()` in its `ui.close` hook, which the spike does.
- *(observed: `claude -p` smoke)* When the `-p` session ended, the ticker got **SIGTERM** and exited. `ticker.log` shows `got SIGTERM`, then `exit`, and `pgrep` found nothing afterwards. Its Unix socket was cleaned up.
- *(observed: owner run)*
  - (a) auto-close after the turn:
  - (b) close mark:
  - (c) `/exit`:
  - (d) terminal window closed:
  - (e) Ctrl+C twice:

### 5. Can the mod write to the spawned process's stdin? If not, is `$.http.fetch` to `http://127.0.0.1:<port>` allowed?

- *(from docs, not yet observed)*
  - **stdin: no.** `ProcessSpawnRequest.input` is one string that is written to stdin, and then stdin is closed. Without it, stdin is closed from the start. The types say "A string today; a later form may take the text in pieces". The stream returned by `spawn` only reads.
  - **`$.http.fetch`: allowed.** The types say "http or https, to whatever the host reaches, unless the organization's web-fetch policy refuses it". It also takes `socketPath` to go over a Unix socket. Every call is an `http.fetch` event, so another mod or an org policy can refuse it. Limits are 30 s per call and 4 MiB per body.
- *(observed: `claude -p` smoke)* `/coffee-spike ping` POSTed to the ticker over `http://127.0.0.1:<port>/say` and over `socketPath`. Both returned 200 in about 3 ms, and the ticker echoed both lines back on stdout to the pane's message list.
- *(observed: owner run, interactive)*

### 6. Does typing in the Claude prompt ever leak into the pane Input, or the reverse?

- *(from docs, not yet observed)*
  - Keys reach a pane element only while it has focus. Esc hands the keys back to the prompt.
  - `$.ui.open({ focus: true })` is a request. It is granted only while the prompt has the keys over an empty composer.
  - The spike opens without focus on auto-open and with focus on `/coffee-spike`.
  - It redraws the Input once a second as a controlled field (`value` = last `onInput` text). Watch for lost keystrokes.
- *(observed: owner run)*

### Verdict

*(after the owner run)*
