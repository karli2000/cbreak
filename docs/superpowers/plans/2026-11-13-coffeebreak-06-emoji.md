# Coffee Break, Plan 6: Emoji in the chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can type the usual chat shortcuts and get emoji:
- emoticons such as `:)` → 🙂 and `<3` → ❤️;
- shortcodes such as `:heart:`, `:tada:` and `:+1:` → ❤️ 🎉 👍 (the full GitHub/Slack set).

**Architecture:**
- The conversion runs **once, in the mod, when a message is sent**: `/send` carries the converted text.
- The stored message already holds the emoji, so every reader shows them with no change: other people's panes (old plugin versions too), the moderator site, report snapshots and the backlog.
- Received messages are never rewritten.
- A pure module `plugin/hooks/lib/emoji.ts` does the conversion. The shortcode table is generated from the `gemoji` package into a committed file, because an installed mod cannot load npm packages (the same reason the helper ships as a committed bundle).
- The backend and the helper need no change. One pgTAP test pins that the server keeps emoji byte for byte.

**Tech Stack:** TypeScript mod library (pure, no I/O), `gemoji@8.1.0` (MIT; dev dependency, build time only), bun test, pgTAP.

**Spec:** `docs/superpowers/specs/2026-11-11-coffeebreak-design.md`:
- §4.4 (pane, in-pane commands);
- §5.2 (settings);
- §6.2 / §6.4 (server-side cleaning, ≤280 characters).

The spec says nothing about emoji, so this plan adds the feature. **Also read:** `CLAUDE.md`: the "Mod pure library", Controller and Plugin tests bullets.

## Global Constraints

- **Pure mod code:** `emoji.ts` and `emoji-data.ts` are pure ES modules with static imports only. No I/O, no Node APIs, no npm imports at runtime (same rule as `format.ts`).
- **Where it converts:** only the body of a chat message (`say`) and of an action (`/me`), right before `/send`.
  - Never `/report`, `/del`, `/mute` or `/ban` reasons, nicknames, or `/coffee` subcommands.
  - Never received messages.
- **Shortcodes:**
  - `:name:`, where `name` matches `[a-z0-9_+-]+` after lowercasing.
  - Replaced only when `name` is one of gemoji's names (every alias of every emoji, e.g. `+1` and `thumbsup`).
  - Unknown names stay as typed.
  - The lookup must not see inherited object keys: `:constructor:`, `:__proto__:` and `:tostring:` stay as typed. Use a `Map`.
- **Emoticons:** exactly this table (case-sensitive, longest match first):

  | Typed | Emoji |
  |---|---|
  | `:)` `:-)` `=)` | 🙂 |
  | `:(` `:-(` | 🙁 |
  | `:D` `:-D` | 😄 |
  | `xD` `XD` | 😆 |
  | `;)` `;-)` | 😉 |
  | `:P` `:-P` `:p` `:-p` | 😛 |
  | `;P` `;p` | 😜 |
  | `:O` `:-O` `:o` `:-o` | 😮 |
  | `:'(` | 😢 |
  | `:\|` `:-\|` | 😐 |
  | `:/` `:-/` | 😕 |
  | `:*` `:-*` | 😘 |
  | `>:(` | 😠 |
  | `^_^` | 😊 |
  | `-_-` | 😑 |
  | `<3` | ❤️ (U+2764 U+FE0F) |
  | `</3` | 💔 |

- **When an emoticon is replaced:** only as a token on its own.
  - It must have the start of the text or whitespace before it.
  - It must have the end of the text, whitespace, or one of `.` `,` `!` `?` after it.
  - So `https://x.dev`, `12:30`, `std::vector`, `(option B)` and `great:)` stay as typed.
- **Code spans stay as typed:** text between a pair of backticks (`` `…` ``) is never converted. An unpaired backtick protects nothing.
- **Setting:** `emoji` (default `on`).
  - `/coffee config emoji on|off` turns it on or off. The settings line shows `emoji on|off`.
  - Stored as `emoji: boolean` through `mergeStored`.
  - With `off`, the body is sent exactly as typed.
- **Length:** the conversion never makes a body longer in code points. Each emoji is at most as long as its shortcode, colons included, and every emoticon emoji is at most as long as what was typed. The server's 280 limit and cleaning stay authoritative; the mod adds no length check.
- **Copy:** `paneHelp` gains ` · :) <3 :heart: → emoji` at the end of the user part.
- **Release:**
  - Bump `plugin/.claude-plugin/plugin.json` `version` to `0.2.2`.
  - No helper change, so no `helper:bundle`.
  - No migration, so nothing to push.
- **Workflow:**
  - Test-first.
  - Keep `CLAUDE.md` current.
  - Commits end with a `Co-Authored-By:` trailer.
  - Never push.
  - Start from `main` after Plan 5 is merged, on branch `plan-6-emoji`.

## Review Focus

1. **URLs, times and code in a message** (`see https://x.dev/a:b`, `at 12:30`, `` `a:b:c:` ``, `std::vector`). Expected: sent exactly as typed. → Task 1 test `leaves urls, times and code alone`.
2. **Prototype keys as shortcodes** (`:constructor:`, `:__proto__:`, `:tostring:`). Expected: as typed, no crash, no `[object Object]`. → Task 1 test `ignores names that are not gemoji`.
3. **Complex emoji through the server:** ZWJ sequences, skin tones, flags and VS16, e.g. 👨‍👩‍👧, 👍🏽, 🇩🇪, ❤️. Expected: `send_message` stores and returns the same string, and `char_length` counts code points for the 280 limit. → Task 2 pgTAP `emoji survive send_message unchanged`.
4. **The table can't grow a body:** a full table sweep. Expected: for every name, emoji code points ≤ name length + 2. → Task 1 test `no replacement makes a body longer`.
5. **Emoji off, and `/me`.** Expected: with `emoji off` the `/send` body is exactly the draft; `/me waves :)` sends `/me waves 🙂`; a `/report` reason with `:)` is sent as typed. → Task 2 controller tests.

---

### Task 1: Emoji conversion library and generated table

**Files:**
- Create:
  - `scripts/gen-emoji.ts`
  - `plugin/hooks/lib/emoji-data.ts` (generated, committed)
  - `plugin/hooks/lib/emoji.ts`
  - `tests/unit/emoji.test.ts`
- Modify: `package.json` (dev dependency `"gemoji": "8.1.0"`, exact pin; script `"emoji:gen": "bun scripts/gen-emoji.ts"`)

**Interfaces:**
- **`plugin/hooks/lib/emoji-data.ts`:**
  - `export const SHORTCODES: ReadonlyArray<readonly [name: string, emoji: string]>`, sorted by name.
  - Header comment: `// generated by scripts/gen-emoji.ts from gemoji 8.1.0; do not edit`.
- **`scripts/gen-emoji.ts`:**
  - Exports `renderEmojiData(): string`, the exact file text, deterministic.
  - Writes the file when run directly (`import.meta.main`).
- **`plugin/hooks/lib/emoji.ts`:**
  - `export const EMOTICONS: ReadonlyArray<readonly [typed: string, emoji: string]>` (the Global Constraints table).
  - `export function emojify(text: string): string`.
  - The `Map` is built once at module load from `SHORTCODES`.

- [ ] **Step 1: Write the failing tests** (`tests/unit/emoji.test.ts`):
  - `converts emoticons`:
    - `emojify(':)')` → `🙂`;
    - `emojify('hi :) there')` → `hi 🙂 there`;
    - `emojify('<3')` → `❤️`;
    - `emojify('nice :D!')` → `nice 😄!`;
    - `emojify(">:( no")` → `😠 no` (longest match, not `>` + `🙁`);
    - every row of `EMOTICONS` round-trips on its own.
  - `converts shortcodes`:
    - `:heart:` → `❤️`, `:tada:` → `🎉`, `:+1:` → `👍`, `:thumbsup:` → `👍`;
    - `:Heart:` → `❤️` (lowercased lookup);
    - `a:heart:b` → `a❤️b` (shortcodes need no spaces around them);
    - `:heart::tada:` → `❤️🎉`.
  - `ignores names that are not gemoji`: `:nope:`, `:constructor:`, `:__proto__:`, `:tostring:` and `::` are each unchanged.
  - `leaves urls, times and code alone`: each unchanged:
    - `https://x.dev/a:b`;
    - `at 12:30`;
    - `std::vector`;
    - `(option B)`;
    - `great:)`;
    - `` `:) :heart:` ``;
    - `` `a:b:c:` ``.
  - `converts outside a code span`: `` `x` :) `` → `` `x` 🙂 ``; an unpaired backtick protects nothing: `` ` :) `` → `` ` 🙂 ``.
  - `no replacement makes a body longer`: for every `[name, emoji]` in `SHORTCODES`, `[...emoji].length <= name.length + 2`; for every `EMOTICONS` row, `[...emoji].length <= [...typed].length`.
  - `table is fresh`: `renderEmojiData()` equals the committed `emoji-data.ts` text. On failure the message reads `emoji-data.ts is stale: run bun run emoji:gen`.
  - `table is complete`: it contains `heart`, `+1`, `-1`, `100`, `tada`, `coffee` and `de`, and more than 1500 names.
- [ ] **Step 2:** Run `bun test tests/unit/emoji.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Run `bun add -d gemoji@8.1.0`. Write `gen-emoji.ts`:
  - one entry per alias in `gemoji[i].names`;
  - names deduplicated, first emoji wins;
  - output as JSON-escaped string literals.
  
  Run `bun run emoji:gen`, then write `emoji.ts`. Approach:
  1. Split the text on paired backticks; convert only the parts outside them.
  2. In those parts, replace `/:([a-z0-9_+-]+):/gi` through the `Map` first.
  3. Then replace emoticons with one regex built from `EMOTICONS`, longest first, all escaped, as `(^|\s)(<alternation>)(?=$|[\s.,!?])`.
- [ ] **Step 4:** GREEN: `bun test tests/unit/emoji.test.ts`, `bun run test:unit` and `bunx tsc --noEmit` all pass.
  - The root tsconfig already covers `plugin/hooks/lib`; check that `tsc` includes `emoji.ts`.
- [ ] **Step 5:** Commit `feat(mod): emoji conversion library (emoticons and gemoji shortcodes)`.

### Task 2: Send with emoji, setting, help and release

**Files:**
- Modify:
  - `plugin/hooks/lib/settings.ts`
  - `plugin/hooks/lib/commands.ts`
  - `plugin/hooks/lib/setup.ts` (the `FIELD` map)
  - `plugin/hooks/lib/copy.ts`
  - `plugin/hooks/lib/controller.ts` (`roomCommand`, `say`/`me` case)
  - `tests/unit/settings.test.ts`, `tests/unit/commands.test.ts`, `tests/unit/controller-break.test.ts`
  - `plugin/tests/mod.test.ts`
  - `plugin/skills/coffee/SKILL.md`, `README.md` (commands section)
  - `plugin/.claude-plugin/plugin.json`
  - `CLAUDE.md`
- Create: `supabase/tests/120_emoji.test.sql`

**Interfaces:**
- Consumes: `emojify(text: string): string` from Task 1.
- Produces:
  - `Settings` gains `emoji: boolean`; `DEFAULTS.emoji = true`.
  - `SettingKey` gains `'emoji'`; `validateSetting('emoji', 'on'|'off'|'true'|'false')`.
  - The error copy is `emoji must be on or off.`
  - The `/coffee config` usage string gains ` | emoji on|off`.
  - `COPY.settingsLine` gains ` · emoji on|off` after auto-open.

- [ ] **Step 1: Write the failing tests:**
  - `settings.test.ts`:
    - `validateSetting('emoji','off')` → `{ok:true,value:false}`;
    - `'maybe'` → the error;
    - `mergeStored({})` gives `emoji: true`;
    - `mergeStored({emoji:false})` gives `false`;
    - a non-boolean falls back to `true`.
  - `commands.test.ts`: `parseCoffeeArgs('config emoji off')` → `config_set` with key `emoji`, value `false`.
  - `controller-break.test.ts` (in a break, `FakePort`):
    - `send converts emoji`: submit `hi :) :tada:` → `/send` body `hi 🙂 🎉`;
    - `/me waves <3` → `/me waves ❤️`;
    - `emoji off sends as typed`: after the setting is saved `off`, submit `hi :)` → `/send` body `hi :)`;
    - `report reason is not converted`: `/report lena spam :)` → `/report` reason `spam :)`.
  - `plugin/tests/mod.test.ts`: in a break, typing `hey :heart:` sends a fetch whose body JSON has `body: 'hey ❤️'`.
  - `supabase/tests/120_emoji.test.sql` → `emoji survive send_message unchanged`:
    - a user in a test room sends `'👨‍👩‍👧 👍🏽 🇩🇪 ❤️ ☕'`;
    - the returned `body` and the stored row are `is()` equal to the input;
    - a body of 280 × `❤` (U+2764, one code point each) is accepted;
    - 281 is refused with `too_long`.
- [ ] **Step 2:** RED: `bun run test:unit` fails on the new cases. `bun run db:test` should already pass for `120_emoji`: it pins existing behaviour, so note that in the report rather than forcing a failure.
- [ ] **Step 3:** Implement:
  - Setting key, `FIELD['emoji'] = 'emoji'`, copy.
  - In `roomCommand`, apply `emojify` to `cmd.body` when `this.settings.emoji` (or however the controller reads settings) for `say` and `me` only.
  - `paneHelp` suffix.
  - SKILL.md and README: one line each under commands, plus the setting.
  - `plugin.json` version `0.2.2`.
- [ ] **Step 4:** GREEN:
  - `bun run test:unit`;
  - `bun run test:mod`;
  - `bun run db:test`;
  - `bunx tsc --noEmit` and `bunx tsc --noEmit -p plugin`;
  - `bun run validate:all`, with only ICON_MISSING as a warning.
- [ ] **Step 5:** Update `CLAUDE.md`:
  - the mod library bullet: `emoji.ts`, `emoji-data.ts`, the `emoji:gen` command in Commands, and the rule "run it after a gemoji bump";
  - the settings in the Setup bullet;
  - the Packaging version line.
  
  Commit `feat(mod): emoji in sent messages, emoji setting`.
- [ ] **Step 6: Owner check (not automated):**
  - Run `bun run dev` with `COFFEEBREAK_HELPER_SRC=1` in the owner's own terminal (Windows Terminal on WSL, 100 columns).
  - Send `:) <3 :tada: 👨‍👩‍👧` and check that the line draws and wraps cleanly.
  - Terminals disagree on the width of VS16 emoji such as ❤️; if the line misaligns there, record it in `spikes/FINDINGS.md`.

---

## Decisions this plan makes

- **Convert on send, not on display:** everyone sees the same thing, old plugin versions and the moderator site included, and the server stays the single source of the text. The cost is that a message from an old plugin that contains `:)` stays as typed for everyone.
- **No live replacement in the input while typing:** the pane's Input is controlled through `draft`, and rewriting it mid-typing risks moving the cursor. The emoji appear when the message lands. This can be a follow-up if the owner wants it.
- **No `:hea…` autocomplete popup:** it is out of scope for this plan.
- **Full gemoji set via a generated, committed table:** this gives the "standard shortcuts" with no runtime dependency, and a freshness test keeps it in step with the pinned package.
- **Strict emoticon boundaries:** these protect URLs, times and code at the cost of `great:)` staying as typed. People who don't want conversion turn it off with `/coffee config emoji off`, or wrap the text in backticks.
