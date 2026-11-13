# Deploy notes: hosted Supabase project

Beta operations (inviting friends, shipping updates, pre-publication checklist): [beta.md](beta.md).

- **Project:** `coffeebreak` (the Supabase names were kept when the product became cbreak), ref `meioekkvutvrspfvqgye`, region `eu-central-1` (Frankfurt), free tier, organization `coffeebreak`. Created 2026-11-12.
- **API URL:** `https://meioekkvutvrspfvqgye.supabase.co`
- **Keys:** never committed. Get them with `bunx supabase projects api-keys --project-ref meioekkvutvrspfvqgye`.

## What was done (Task 11)

1. Created the project (Supabase MCP `create_project`).
2. `bunx supabase login` (owner), then `bunx supabase link --project-ref meioekkvutvrspfvqgye`.
3. `bunx supabase db push --remote --yes` applied all 13 migrations (000100 … 000800). The `coffeebreak-purge` pg_cron job is scheduled.
4. Ran the security and performance advisors. Remaining findings are deliberate:
   - `public_profiles` is a security-definer view exposing only `id, nickname, role`.
   - RPCs are executable by `authenticated`; role checks happen inside each RPC.
   - `banned_github_ids` has RLS with no policies (no API access at all).
   - Unused indexes are only unused because the DB is new.
5. `bunx supabase functions deploy github-age --yes`.
6. Integration tests against the hosted project, all 14 passing. They use dedicated `itest-*` rooms and leave nothing behind:
   ```bash
   export SUPABASE_URL=https://meioekkvutvrspfvqgye.supabase.co SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=…
   INTEGRATION_ALLOW_REMOTE=1 bun test tests/integration
   ```
7. GitHub login set up by the owner, then verified with spike S3. The owner's profile `karli2000` was set to `admin`.

## Automatic deploys (GitHub Actions)

Merging a pull request into `main` deploys what it changed. Each workflow in `.github/workflows/` runs only when its paths changed, and can also be started by hand (Actions → the workflow → Run workflow):

| Workflow | Runs when a merge changes | Does |
|---|---|---|
| `deploy-database.yml` | `supabase/migrations/**` | Starts a local stack, runs `bun run db:test` (pgTAP), and only if that passes: `supabase db push --remote=meioekkvutvrspfvqgye --skip-vault` (dry run first, so the log lists the migrations). |
| `deploy-functions.yml` | `supabase/functions/**` | `supabase functions deploy github-age --use-api` (bundled server-side, no Docker). Its `GITHUB_TOKEN` secret stays in the dashboard. |
| `deploy-mod-site.yml` | `site/**` and the two files the site imports from outside it (`plugin/hooks/lib/format.ts`, `plugin/shared/backend.ts`) | The site's headers test, then `bun run site:deploy` (Pages project `coffeebreak-mod`, mod.cbreak.dev). |
| `deploy-homepage.yml` | `web/**` | `tests/unit/web.test.ts`, then `bun run web:deploy` (Pages project `cbreak-web`, cbreak.dev). |

None of them ever runs `supabase config push`. Each deploy job runs in the GitHub environment `production` (created on the first run; add required reviewers there if you ever want to approve deploys by hand) and stops with an error naming the missing secret when one is not set. Actions are pinned to commit SHAs; `tests/unit/workflows.test.ts` checks the pins, the paths (including every file the site imports from outside `site/`), the project ref and the commands.

Repository secrets (GitHub → Settings → Secrets and variables → Actions → New repository secret; or `gh secret set <NAME>` in your own terminal, which prompts for the value; never paste a secret into a chat):

- `SUPABASE_ACCESS_TOKEN`: a personal access token from https://supabase.com/dashboard/account/tokens. If the dashboard lets you scope it, limit it to the project `coffeebreak` with the permissions the CLI lists for these commands: `database_write`, `database_pooling_config_read`, `projects_read`, `branching_production_read`, `edge_functions_write`, `edge_functions_read`. No database password is needed: without one the CLI signs in through a temporary login role (`Initialising login role...`).
- `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token with **Account → Cloudflare Pages → Edit** for your account.
- `CLOUDFLARE_ACCOUNT_ID`: shown by `bunx wrangler@4.161.0 whoami`, or in the dashboard's account overview.

Order: a migration reaches production a few minutes after the merge (the pgTAP job runs first), while a plugin change in the same merge is on `main` at once. When a new helper needs a new database function, merge the migration in its own pull request first and wait for the green deploy, then merge the plugin change.

The pages project `cbreak-web` must exist before the first homepage deploy (`bunx wrangler@4.161.0 pages project create cbreak-web --production-branch main`, once). The manual commands below still work, for example to redeploy without a merge.

## Auth configuration (dashboard, set by the owner)

- **GitHub provider:** enabled. It's a GitHub **App** (Client ID `Iv23li…`) with callback `https://meioekkvutvrspfvqgye.supabase.co/auth/v1/callback` and **Account permissions → Email addresses: Read-only**.
- **Site URL:** `https://mod.cbreak.dev` (the moderator site's custom domain; set by the owner on 2026-11-14, before that `https://coffeebreak-mod.pages.dev` from 2026-11-12, step 4 in [moderator-site.md](moderator-site.md)). Until then it was the GitHub repo, which is where a sign-in landed when its redirect target was not allow-listed.
- **Access token (JWT) expiry:** 900 s (set by the owner on 2026-11-12). This limits how long a banned client can keep reading its current room on an already-open channel.
- **Redirect URLs:** `http://127.0.0.1:*/callback` (cbreakd's local login callback), `https://coffeebreak-mod.pages.dev/**` and `http://localhost:5173/**` (moderator site; added by the owner on 2026-11-12), `https://mod.cbreak.dev/**` (custom domain, 2026-11-14). A redirect target missing from this list makes Supabase fall back to the Site URL.
- **Do not run `supabase config push`.** It would overwrite these dashboard settings with the local `config.toml`.

## Before the friends beta (owner checks)

1. **Auth → Providers → Email:** keep **Confirm email** ON and do not configure custom SMTP. Otherwise outsiders could sign up with an email address, and bans would not stick (bans are keyed by GitHub id). The hosted integration tests rely on the Email provider being enabled, so leave it enabled.
2. **`GITHUB_TOKEN` secret:** done on 2026-11-12. The owner created a fine-grained GitHub token (public repositories read-only, no permissions) and added it under Edge Functions → Secrets. Fine-grained tokens expire, so renew it before its expiry date. Without it, `github-age` shares GitHub's unauthenticated limit of 60 requests/hour per IP. No redeploy is needed after changing it.
3. **Migration 000900:** applied to the hosted project by the owner on 2026-11-12 (`bunx supabase db push --remote`); the hosted project now has all 14 migrations and the 14 integration tests pass against it.

## Recommended, not done

- Free projects pause after about a week without activity. Unpause from the dashboard if that happens during the beta.

## Moderator site

Build, deploy and owner steps for the static moderator site: see [moderator-site.md](moderator-site.md). Its redirect URLs go into the same dashboard page as above.
