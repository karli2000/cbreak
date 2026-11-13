# Beta runbook (owner)

Coffee Break is a friends-only beta: the repo is public, but sign-up is invite-only (`beta_settings.invite_only`). Hosted project and deploy notes: [deploy.md](deploy.md). Moderator site: https://coffeebreak-mod.pages.dev. Details: [moderator-site.md](moderator-site.md).

## Pre-publication checklist

1. `bunx supabase db push --remote` (migrations 20261113000100, the invite gate with `invite_only` on from the start, and 20261113000200, multi-session; both go out in this one push, and it must happen before plugin 0.2.1 is used).
2. `bun run site:deploy` (the invites UI and the CSP change reach production only after this).
3. You need no invite yourself: the gate only applies to a first `claim_nickname` and you already have a profile.
4. **Decide about the commit-author email.** Every commit is authored with your personal email (the address in your git config), and a public repo exposes it. Options: accept it; rewrite history to a GitHub noreply address with `git filter-repo --mailmap` and force-push `main` (destructive, you run it); or use a noreply address for future commits only (`git config user.email`). A rewrite must also pass `--replace-text` (a file with the address `==>` the noreply address): earlier versions of `docs/beta.md`, `CLAUDE.md` and the Plan 4 plan spelled the address out, and `--mailmap` only changes author and committer fields, not file contents.
5. Run `scripts/prepublish-audit.sh --history` (must exit 0).
6. `gh repo edit karli2000/coffeebreak --visibility public --accept-visibility-change-consequences`
7. **Test the install from a clean session.** In a fresh Claude Code session (not `--plugin-dir`, no other Coffee Break copy loaded):
   ```sh
   claude plugin marketplace add karli2000/coffeebreak
   claude plugin install coffeebreak@coffeebreak
   ```
   Start Claude Code and check that `/coffee` is registered (the mod loaded from the installed copy), and that `/coffee status` answers (the bundled helper starts through Bun). Do not rely on `claude plugin details`: an earlier local install test showed `Hooks (0)` there, so only a real session confirms the mod loads. Then run `/coffee setup` end to end.
8. Send friends the message below.

## Inviting a friend

1. Ask for their GitHub username.
2. Open the moderator site, go to Admin, then Invites.
3. Enter the username (a leading `@` is fine), add an optional note, and add it. The site looks up the numeric GitHub id for you.
4. Send them the message below. Removing an invite later never removes an existing profile.

## Message to send

> Coffee Break is a Claude Code plugin: a shared chat room that opens while Claude is busy and closes when it is done. I added your GitHub account to the invite list.
>
> Needs Claude Code 2.1.322+ and Bun (`curl -fsSL https://bun.sh/install | bash`).
>
> ```
> claude plugin marketplace add karli2000/coffeebreak
> claude plugin install coffeebreak@coffeebreak
> ```
>
> Restart Claude Code, then run `/coffee setup`. Privacy and commands: https://github.com/karli2000/coffeebreak#readme. The pane needs a wide terminal; in a narrow one, use `/coffee` while Claude is busy.

## Feedback

Friends report problems as GitHub issues: https://github.com/karli2000/coffeebreak/issues

## Free tier limits

The hosted project is on Supabase's free tier:

- Concurrent Realtime connections are capped (about 200). Each person on a break holds one, so the beta fits, but it is a hard ceiling.
- Database size is capped (500 MB). Messages purge after 15 minutes, so this is not a concern for chat.
- The project pauses after about a week without activity. If friends cannot join, open the Supabase dashboard and unpause the project (a few minutes). A pause during a quiet week is expected.

Check the current limits on Supabase's pricing page before a bigger invite wave.

## Shipping an update

1. Change the code and tests.
2. Bump `version` in `plugin/.claude-plugin/plugin.json` (users stay on a version until it changes).
3. `bun run helper:bundle` (a test fails if the committed `plugin/dist/coffeebreakd.js` is stale).
4. `bun run validate:all`, commit, push.
5. Friends run `claude plugin marketplace update coffeebreak`, then `claude plugin update coffeebreak@coffeebreak`, and restart Claude Code.

**Order matters:** backend migrations go out with `bunx supabase db push --remote` BEFORE you push a plugin version that needs them. Installed plugins update from GitHub `main`, so a 0.2.1 helper against the old database gets "function not found" from `join_room` and every break start fails.

Backend changes: `bunx supabase db push --remote` (and `functions deploy` when an Edge Function changed). Site changes: `bun run site:deploy`.

## Turning invite-only off

Admin, then Invites, then the `Invite-only` toggle on the moderator site (turning it off asks for a second click). Don't turn it off yet: anyone with a GitHub account could then join a free-tier project with no paid headroom and one moderator.

## Before a public launch

- Move Supabase to a paid plan (Realtime connection and pause limits).
- Publish an imprint and privacy page on the static site (spec section 6.7: the operator's legal notice, if launched publicly in the EU).
- Ship compiled helper binaries (about 110 MB each) so people without Bun can install.
- Consider CI (none yet) and an icon for the plugin directory listing.
