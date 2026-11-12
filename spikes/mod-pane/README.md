# Spike S1: mod pane (throwaway)

This is a minimal Claude Code mod that tests whether Coffee Break's UI idea works: a chat pane that opens beside the transcript while Claude is busy and closes when Claude is done. A stand-in helper (`ticker.ts`) streams JSON lines to the pane the way `coffeebreakd` will. No backend is involved.

What it does:

- About **5 s after a main-agent turn starts**, it opens the pane `coffee-spike` without focus and starts `bun ticker.ts`. The ticker prints `{"type":"message","nick":"bot","body":"tick N"}` once a second, and the pane shows each line.
- Typing in the pane's Input and pressing Enter adds `me: <text>`. It also POSTs the text to the ticker over `127.0.0.1:<port>` and over a Unix socket with `$.http.fetch`. The ticker echoes it back as `echo-tcp: …` and `echo-unix: …`.
- When the turn completes, the pane shows `back to work` and closes **5 s later**. It stays open if the Input still holds text.
- Closing the pane stops the ticker.
- If the mod can't place the pane on its own (the terminal is too narrow), a toast and the status line say `☕ coffee spike ready · /coffee-spike to open`. Otherwise the status line shows the pane, ticker and Claude state.
- `/coffee-spike` opens the pane by hand, with focus, and works mid-turn. `/coffee-spike close` closes it. `/coffee-spike ping` sends `ping` to the ticker without typing.

## Logs (read these afterwards)

- **`/home/max/coffebreak/spikes/mod-pane/spike.log`**: one JSON line for every event the mod sees. That covers `session.start`/`session.end` (with `reason`), `prompt.submit` (length and first 40 chars), `turn.start`/`turn.complete` (with `turnId`, `agentId`, `reason`, `isAborted`, `durationMs`), `ui.open` (with `isPlaced` and `reason`), `pane.render` (terminal size, fullscreen, `dock`/`inline`, late placement), `ui.close` (with `origin`: `plugin`, `person` or `unload`), `spawn.start`/`hello`/`exit`/`stop`/`error` (with pid), `input.change`/`input.submit`, `fetch.tcp`/`fetch.unix` and `close.skipped`. It survives restarts, so delete it before a clean run.
- **`/home/max/coffebreak/spikes/mod-pane/ticker.log`**: the ticker's own lifecycle. It records start, an `alive` line every 10 ticks (with `ppid`), `ORPHANED` if its parent changes, `got SIGTERM`/`SIGHUP`/…, and `exit`. If there is **no `exit` line after the last `alive`**, the ticker was SIGKILLed.

Both files are git-ignored.

## Run it

In your normal WSL terminal, preferably maximised:

```bash
rm -f /home/max/coffebreak/spikes/mod-pane/spike.log /home/max/coffebreak/spikes/mod-pane/ticker.log
which bun            # must print a path; the mod runs `bun` from PATH
tput cols            # note the width
cd /home/max/coffebreak
claude --plugin-dir /home/max/coffebreak/spikes/mod-pane
```

Check that `/plugin` lists `coffee-spike@inline` among the active mods. Then give Claude a long task, for example:

> count to 200 slowly using sleep 1 in bash, one number per call

## Checklist: one block per FINDINGS question

Use this to find the matching log lines: `grep -E 'turn\.|ui\.|spawn\.|fetch\.|close\.' spikes/mod-pane/spike.log`. Write the answers into `spikes/FINDINGS.md`.

1. **Does the pane open on its own at your real width?**
   - Start the long task at your normal width. After about 5 s, does the pane appear? Look for `ui.open` → `isPlaced` and `reason`. If it says it waits for 144 columns, widen the terminal or shrink the font until `tput cols` ≥ 144. Does it then appear by itself (`pane.render` with `latePlacement: true`)?
   - Note `placement` in `pane.render`. `dock` means the pane sits beside the transcript, which needs fullscreen rendering and ≥110 columns. `inline` means it sits above the prompt.
   - Next, close the pane, run `/coffee-spike` once, and close it again *with the command* (`/coffee-spike close`). Then narrow the terminal to between 110 and 143 columns and start another long task. Does it open by itself now? The types say the 110 allowance lasts "until they close the pane by hand", so closing it with the close mark may reset it. Try that too.
2. **Does `turn.start` fire for queued prompts?** While Claude is busy, type a second prompt and press Enter so it queues. Compare the `prompt.submit` lines with the `turn.start` lines (no `agentId`). Did the queued prompt get its own `turn.start`/`turn.complete` pair, or was it folded into the running turn (one `prompt.submit` with `busy: true` and no new `turn.start`)? Does the pane flicker closed and open between the two?
3. **Does `turn.complete` fire with `isAborted` on Esc?** During a long task with the pane open, press Esc in the *prompt* (not in the pane). Look for `turn.complete` with `"isAborted":true,"reason":"aborted"`. Does the pane say `back to work (interrupted)` and close 5 s later? Watch for `ui.close.error` or `spawn.stop.error`, because the docs say new work is refused after an interrupt until your next input.
4. **Does the ticker die?** In a second terminal, run `pgrep -af 'bun .*ticker.ts'` while the pane is open (one process), and again after each of these:
   - (a) the pane closes by itself after the turn
   - (b) you close it by hand with the pane's close mark. The pane is opened without `closeOnEscape`, so Esc only hands the keys back to the prompt and does not close it.
   - (c) `/exit` while the pane is open (start a task, wait for the pane, then `/exit`)
   - (d) **closing the terminal window/tab** while the pane is open
   - (e) Ctrl+C twice while the pane is open

   After each one, run `tail -3 /home/max/coffebreak/spikes/mod-pane/ticker.log` to see which signal it got. For (d), check from another terminal, and look for `ORPHANED` or a missing `exit` line.
5. **Can the mod talk to the helper?** Focus the pane (click it, or open it with `/coffee-spike`), type `hello`, and press Enter. You should see `me: hello`, then `echo-tcp: hello` and `echo-unix: hello`. In the log, check `fetch.tcp` and `fetch.unix` for status 200, and look for any `*.error` lines. `/coffee-spike ping` does the same without typing.
6. **Does typing leak between the Claude prompt and the pane Input?**
   - With the pane open but not focused, type in the Claude prompt. No `input.change` lines should appear.
   - Focus the pane and type a few characters, then press Esc to return to the prompt and type more. Do the characters go to the right place? Does the pane's text survive the once-a-second redraws? There should be no `prompt.submit` containing pane text.
   - Leave text in the pane Input when the turn ends. Look for `close.skipped` with `input has text`, and confirm the pane stays open.

Also note anything odd, such as flicker, a lost cursor, toasts, or the status line.
