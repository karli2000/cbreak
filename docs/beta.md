# Beta runbook (owner)

cbreak is an open beta: the repo is public and anyone with a GitHub account can sign up (the friends-beta invite gate was removed on 2026-11-14, migration 20261114000100). Hosted project and deploy notes: [deploy.md](deploy.md). Moderator site: https://mod.cbreak.dev. Details: [moderator-site.md](moderator-site.md).

## Pre-publication checklist

1. `bunx supabase db push --remote` (every migration through 20261114000100; 20261113000200, multi-session, must be live before plugin 0.2.1 is used).
2. `bun run site:deploy`.
3. **Decide about the commit-author email.** Every commit is authored with your personal email (the address in your git config), and a public repo exposes it. Options: accept it; rewrite history to a GitHub noreply address with `git filter-repo --mailmap` and force-push `main` (destructive, you run it); or use a noreply address for future commits only (`git config user.email`). A rewrite must also pass `--replace-text` (a file with the address `==>` the noreply address): earlier versions of `docs/beta.md`, `CLAUDE.md` and the Plan 4 plan spelled the address out, and `--mailmap` only changes author and committer fields, not file contents.
4. Run `scripts/prepublish-audit.sh --history` (must exit 0).
5. `gh repo edit karli2000/cbreak --visibility public --accept-visibility-change-consequences`
6. **Test the install from a clean session.** In a fresh Claude Code session (not `--plugin-dir`, no other cbreak copy loaded):
   ```sh
   claude plugin marketplace add karli2000/cbreak
   claude plugin install cbreak@cbreak
   ```
   Start Claude Code and check that `/cbreak` is registered (the mod loaded from the installed copy), and that `/cbreak status` answers (the bundled helper starts through Bun). Do not rely on `claude plugin details`: an earlier local install test showed `Hooks (0)` there, so only a real session confirms the mod loads. Then run `/cbreak setup` end to end.
7. Send friends the message below.

## Message to send

> cbreak is a Claude Code plugin: a shared chat room that opens while Claude is busy and closes when it is done.
>
> Needs Claude Code 2.1.322+ and Bun (`curl -fsSL https://bun.sh/install | bash`).
>
> ```
> claude plugin marketplace add karli2000/cbreak
> claude plugin install cbreak@cbreak
> ```
>
> Restart Claude Code, then run `/cbreak setup`. Privacy and commands: https://github.com/karli2000/cbreak#readme. The pane needs a wide terminal; in a narrow one, use `/cbreak` while Claude is busy.

## Moving friends from Coffee Break (0.3.0)

The plugin, marketplace and command were renamed (`coffeebreak@coffeebreak` and `/coffee` became `cbreak@cbreak` and `/cbreak`). Installed copies do not follow a rename, so send friends who installed Coffee Break:

> Coffee Break is now cbreak. Please run `claude plugin uninstall coffeebreak@coffeebreak`, `claude plugin marketplace remove coffeebreak`, then `claude plugin marketplace add karli2000/cbreak` and `claude plugin install cbreak@cbreak`, and restart Claude Code. Your login carries over; the command is now `/cbreak`.

## Feedback

Friends report problems as GitHub issues: https://github.com/karli2000/cbreak/issues

## Free tier limits

The hosted project is on Supabase's free tier:

- Concurrent Realtime connections are capped (about 200). Each person on a break holds one, so the beta fits, but it is a hard ceiling.
- Database size is capped (500 MB). Messages purge after 15 minutes, so this is not a concern for chat.
- The project pauses after about a week without activity. If friends cannot join, open the Supabase dashboard and unpause the project (a few minutes). A pause during a quiet week is expected.

Check the current limits on Supabase's pricing page before inviting a bigger crowd.

## Shipping an update

1. Change the code and tests.
2. Bump `version` in `plugin/.claude-plugin/plugin.json` (users stay on a version until it changes).
3. `bun run helper:bundle` (a test fails if the committed `plugin/dist/cbreakd.js` is stale).
4. `bun run validate:all`, commit on a branch, push it and merge it through a pull request (`main` is PR-only).
5. Friends run `claude plugin marketplace update cbreak`, then `claude plugin update cbreak@cbreak`, and restart Claude Code.

**Order matters:** backend migrations must be live BEFORE a plugin version that needs them reaches `main`. Migrations deploy automatically when their pull request is merged (pgTAP first, a few minutes; see [deploy.md](deploy.md#automatic-deploys-github-actions)), so merge the migration in its own pull request and wait for the green deploy before merging the plugin change. Installed plugins update from GitHub `main`, so a 0.2.1 helper against the old database gets "function not found" from `join_room` and every break start fails.

Backend, function, moderator-site and homepage changes deploy automatically when their pull request is merged into `main` ([deploy.md](deploy.md#automatic-deploys-github-actions)). By hand, if ever needed: `bunx supabase db push --remote`, `bunx supabase functions deploy github-age`, `bun run site:deploy`, `bun run web:deploy`.

## Before a public launch

- Move Supabase to a paid plan (Realtime connection and pause limits).
- Publish an imprint and privacy page on the static site (spec section 6.7: the operator's legal notice, if launched publicly in the EU).
- Ship compiled helper binaries (about 110 MB each) so people without Bun can install.
- Consider CI on pull requests (only the deploy workflows run, on merges into `main`).
