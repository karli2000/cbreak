# Coffee Break

Coffee Break is a Claude Code plugin that drops you into a shared group chat room while Claude is busy on your task, and takes you out when Claude is done. You get a short break with other people who are waiting on their own agents, instead of staring at a spinner. It runs inside Claude Code as a side pane, talks to a small hosted backend, and sends nothing about your work anywhere.

## Status

Beta. Anyone with a GitHub account can sign up. Expect rough edges, and please report them.

## Requirements

- Claude Code 2.1.322 or newer
- Bun 1.2 or newer (`curl -fsSL https://bun.sh/install | bash`)
- macOS, Linux or WSL

## Install

```sh
claude plugin marketplace add karli2000/coffeebreak
claude plugin install coffeebreak@coffeebreak
```

Restart Claude Code, then run `/coffee setup` to sign in with GitHub, pick a nickname and accept the room rules.

## How it works

When Claude has been busy for 20 seconds, Coffee Break opens the chat room in a side pane. Everyone in the room is also waiting on Claude. When Claude finishes, the room stays open for a 15 second grace period and then closes, so you are back at your task. If you are still typing a message, it holds the room until you send or clear it.

The pane needs a wide terminal (about 144 columns). In a narrower terminal it does not open by itself: you get a hint in the status line and a toast, and `/coffee` opens the room. The room can only be opened while Claude is busy.

Rooms hold at most 50 people. A busy room is split into instances, and you are placed in one that has space.

## Commands

| Command | What it does |
|---|---|
| `/coffee` | Open the room (only while Claude is busy). |
| `/coffee setup` | Sign in with GitHub, pick a nickname, accept the rules. |
| `/coffee status` | Who you are signed in as, your settings, whether you are on a break. |
| `/coffee name <nickname>` | Change your nickname (3-20 characters: a-z, 0-9, `_`, `-`; at most once per 30 days after the first change). |
| `/coffee room <name>` | Choose the room (applies from your next break). |
| `/coffee config [min-wait <s> \| grace <s> \| auto-open on\|off \| emoji on\|off]` | Show or change settings (wait 0-600 s, grace 0-300 s, emoji conversion on by default). |
| `/coffee on` / `/coffee off` | Enable or disable Coffee Break. |
| `/coffee logout` | Sign out. |
| `/coffee delete-account yes` | Delete your account and data. |

In the chat pane:

| Command | What it does |
|---|---|
| (just type) | Send a message (1-280 characters). Start with `//` to send a literal `/`. |
| `/me <action>` | Send an action line. |
| `/report <nick> <reason>` | Report a person to the moderators. |
| `/leave` | Close the pane and leave the room. |
| `/help` | List the commands. |

Emoji: `:)`, `;)`, `:D`, `<3` and the other usual emoticons, and GitHub shortcodes such as `:heart:`, `:tada:` or `:+1:`, turn into emoji when you send. Emoticons convert only as a word of their own and shortcodes never inside a word (so links, times and keys like `user:id:42` stay as typed), text in backticks is never converted, and `/coffee config emoji off` turns it off.

Moderators and admins also have `/del <nick> [reason]` (delete their latest message), `/mute <nick> <10\|60\|1440> <reason>` (minutes) and `/ban <nick> <reason>`.

## Privacy

The mod sees prompts and tool calls (it has to, to detect busy and idle), but never sends them anywhere. The only data that leaves your machine: the auth token, the room name, the chat text you typed, and the reports you filed.

The code, prompts, file names and project data never leave your machine, and the backend has no place to store them.

What the server keeps, and for how long:

- Chat messages: 15 minutes.
- Reports (with a snapshot of the nearby chat lines): 90 days after they are resolved.
- Moderator actions: 1 year.
- Your profile (nickname, GitHub user id, GitHub account creation date, role, mute or ban state): until you delete your account. Other people in the rooms only ever see your nickname, never your GitHub name.
- If you were banned, a one-way hash of your GitHub id stays after you delete your account, so the ban sticks.

Run `/coffee delete-account yes` to delete your account and everything tied to it. Signing in with GitHub without finishing setup still leaves a sign-in record with Supabase Auth (your GitHub email and public profile data); `/coffee delete-account yes` removes it as well, even though you never picked a nickname. Data is hosted on Supabase in Frankfurt (eu-central-1).

## Room rules

- Be kind.
- No spam.
- Don't share private or company data.
- Moderators can remove you.

Messages are rate limited (at least 2 seconds apart, at most 5 per 10 seconds), and very new GitHub accounts wait longer between messages.

## Moderation

Anyone in a room can report a person with `/report <nick> <reason>`. Three different people reporting the same person within 10 minutes mutes them for 24 hours automatically. Moderators review reports, delete messages and mute (10 minutes, 1 hour or 24 hours) or ban people. Admins also manage moderators, rooms, the word filter and invites. Staff can only act on people with a lower role.

Moderators use the moderator site: https://coffeebreak-mod.pages.dev (sign in with GitHub).

## Troubleshooting

- **"Coffee Break needs Bun"**: install Bun with `curl -fsSL https://bun.sh/install | bash`, then restart Claude Code. The mod looks for `bun` on your `PATH` and at `~/.bun/bin/bun`.
- **The pane does not show up**: your terminal is probably narrower than about 144 columns. Use `/coffee` while Claude is busy, or widen the terminal.
- **A stale helper**: the mod starts a small background helper (`coffeebreakd`) that exits on its own when Claude Code closes, or after 60 seconds without hearing from the mod. If something looks stuck, restart Claude Code.
- Anything else: https://github.com/karli2000/coffeebreak/issues

## Development

Architecture rules, the database layout, the plugin and site internals and all test commands are in [CLAUDE.md](CLAUDE.md). The usual ones:

```sh
bun install
bun run db:start      # local Supabase stack (Docker)
bun run db:test       # pgTAP tests
bun run test:unit     # plugin unit tests
bun run test:mod      # plugin validate + mod tests
bun run test:site     # moderator site tests
bun run test:int      # integration tests (needs the local stack)
bun run dev           # claude --plugin-dir plugin
bun run validate:all  # validate marketplace and plugin
```

Before changing repository visibility, run `scripts/prepublish-audit.sh --history`. The beta runbook is in [docs/beta.md](docs/beta.md).

## License

MIT, see [LICENSE](LICENSE).
