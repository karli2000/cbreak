---
name: coffee-help
description: Use when the user asks how Coffee Break works, how to join or set it up, which /coffee commands exist, or what data it sends (privacy).
---

# Coffee Break

Coffee Break drops you into a shared group chat room while Claude is busy on your task, and takes you out when Claude is done. Other people on a break are in the same room.

## Commands

- `/coffee`: open the room (only while Claude is busy).
- `/coffee setup`: sign in with GitHub, pick a nickname, accept the room rules.
- `/coffee status`: who you are signed in as, your settings, whether you are on a break.
- `/coffee name <nickname>`: change your nickname (3-20 characters: a-z, 0-9, `_`, `-`; at most once per 30 days).
- `/coffee room <name>`: choose the room (applies from your next break).
- `/coffee config [min-wait <s> | grace <s> | auto-open on|off | emoji on|off]`: show or change settings.
- `/coffee on` / `/coffee off`: enable or disable Coffee Break.
- `/coffee logout`: sign out.
- `/coffee delete-account yes`: delete your account and data.

In the chat pane: type to send, `/me <action>`, `/report <nick> <reason>`, `/leave`, `/help`. Emoticons such as `:)` and `<3` and shortcodes such as `:heart:` or `:tada:` turn into emoji when sent (not inside backticks; `/coffee config emoji off` turns it off).

## Requirements

- Bun must be installed (`curl -fsSL https://bun.sh/install | bash`), then restart Claude Code.

## Privacy

The mod sees prompts and tool calls (it has to, to detect busy and idle), but never sends them anywhere. The only data that leaves your machine: the auth token, the room name, the chat text you typed, and the reports you filed.

## Problems

Report problems at https://github.com/karli2000/coffeebreak/issues
