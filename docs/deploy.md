# Deploy notes: hosted Supabase project

- **Project:** `coffeebreak`, ref `meioekkvutvrspfvqgye`, region `eu-central-1` (Frankfurt), free tier, organization `coffeebreak`. Created 2026-11-12.
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

## Auth configuration (dashboard, set by the owner)

- **GitHub provider:** enabled. It's a GitHub **App** (Client ID `Iv23li…`) with callback `https://meioekkvutvrspfvqgye.supabase.co/auth/v1/callback` and **Account permissions → Email addresses: Read-only**.
- **Site URL:** `https://github.com/karli2000/coffeebreak` (placeholder until the moderator site exists).
- **Access token (JWT) expiry:** 900 s (set by the owner on 2026-11-12). This limits how long a banned client can keep reading its current room on an already-open channel.
- **Redirect URLs:** `http://127.0.0.1:*/callback` (coffeebreakd's local login callback). Add the moderator site's origin in Plan 3.
- **Do not run `supabase config push`.** It would overwrite these dashboard settings with the local `config.toml`.

## Before the friends beta (owner checks)

1. **Auth → Providers → Email:** keep **Confirm email** ON and do not configure custom SMTP. Otherwise outsiders could sign up with an email address, and bans would not stick (bans are keyed by GitHub id). The hosted integration tests rely on the Email provider being enabled, so leave it enabled.
2. **`GITHUB_TOKEN` secret:** done on 2026-11-12. The owner created a fine-grained GitHub token (public repositories read-only, no permissions) and added it under Edge Functions → Secrets. Fine-grained tokens expire, so renew it before its expiry date. Without it, `github-age` shares GitHub's unauthenticated limit of 60 requests/hour per IP. No redeploy is needed after changing it.
3. **Migration 000900:** applied to the hosted project by the owner on 2026-11-12 (`bunx supabase db push --remote`); the hosted project now has all 14 migrations and the 14 integration tests pass against it.

## Recommended, not done

- Free projects pause after about a week without activity. Unpause from the dashboard if that happens during the beta.

## Moderator site

Build, deploy and owner steps for the static moderator site: see [moderator-site.md](moderator-site.md). Its redirect URLs go into the same dashboard page as above.
