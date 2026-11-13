# Moderator site

Static React + Vite app in `site/` (supabase-js in the browser, no server code, no service-role key). It is hosted on Cloudflare Pages as project `coffeebreak-mod` at **https://mod.cbreak.dev** (custom domain, owner, 2026-11-14); the project's default URL `https://coffeebreak-mod.pages.dev` still serves the same site.

## Local dev

```bash
bun run site:dev              # http://localhost:5173, against the hosted backend
```

The local Supabase stack has no GitHub provider, so you can only sign in against the hosted backend (from `plugin/shared/backend.ts`). That is why `http://localhost:5173/**` is in the hosted project's redirect URLs (owner step 2).

The local stack is for tests only: `bun run test:site` needs no stack, and `bun test tests/integration/site-api.test.ts` reads the local URL and keys from `bunx supabase status` by itself.

To point the dev server at another backend anyway, set the overrides on the command itself, never with `export`, so they cannot leak into a later `bun run site:deploy` in the same shell:

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=<anon key> bun run site:dev
```

or put them in `site/.env.development.local` (git-ignored; Vite reads it only for `vite` dev, never for `vite build`).

## Build

```bash
bun run site:build            # output in site/dist
bun run test:site             # includes a real build and checks dist (headers, no secrets, no inline script/style, hosted backend URL)
```

The build test runs `vite build` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` removed from its environment and checks that the bundle contains `https://meioekkvutvrspfvqgye.supabase.co` and no local stack URL. `bun run site:build` itself uses whatever is in your shell, so keep those variables out of it.

The site build does not need the generated plugin types (`plugin/.claude-plugin/types/`): `site/vite.config.ts` pins Vite to `site/tsconfig.json`, so a fresh clone builds.

`site/public/_headers` is copied to `dist/_headers`; Cloudflare Pages applies it (CSP, nosniff, no-referrer, Permissions-Policy). The CSP allows only `'self'` plus the hosted Supabase project (https and wss). If the backend URL changes, update `_headers`.

## Deploy

```bash
bunx wrangler@4.161.0 login                                                          # once
bunx wrangler@4.161.0 pages project create coffeebreak-mod --production-branch main  # once
bun run site:deploy           # builds, then wrangler pages deploy site/dist --project-name coffeebreak-mod --branch main
```

`site:deploy` always passes `--branch main`, so the upload is the production deployment (https://mod.cbreak.dev, and `https://coffeebreak-mod.pages.dev`) whatever git branch is checked out. Without it, wrangler uses the current git branch, and a branch other than the production branch becomes a preview at `<hash>.coffeebreak-mod.pages.dev`, which is not in the redirect allowlist. The wrangler version is pinned in the script and above; bump it in both places together.

Custom domain `mod.cbreak.dev` (owner, 2026-11-14): Pages dashboard → `coffeebreak-mod` → Custom domains (the `mod` CNAME points at `coffeebreak-mod.pages.dev`; Cloudflare issues the certificate, and `.dev` is HTTPS-only). Supabase Site URL `https://mod.cbreak.dev`, redirect URL `https://mod.cbreak.dev/**` added next to the `pages.dev` one. No code change: sign-in redirects to the page's own origin and the CSP lists only Supabase. To retire the old address later, remove `https://coffeebreak-mod.pages.dev/**` from the redirect URLs. A public imprint waits for a public launch.

## Owner steps, in order

1. `bunx supabase db push --remote` (applies `20261112000100_moderator_site.sql`: `mod_list_banned`, `admin_list_staff`, `admin_unban_github_id`).
2. Supabase dashboard, Authentication, URL Configuration, Redirect URLs: add `https://coffeebreak-mod.pages.dev/**` and `http://localhost:5173/**`. Keep the existing entries.
3. `bunx wrangler@4.161.0 login`, then `bunx wrangler@4.161.0 pages project create coffeebreak-mod --production-branch main`, then `bun run site:deploy`. Run the deploy from a shell without `VITE_SUPABASE_*` set.
4. After the first deploy: Supabase dashboard, Authentication, URL Configuration, Site URL: set it to `https://coffeebreak-mod.pages.dev` (it is still the GitHub-repo placeholder). Leave the redirect URLs as they are.

## Owner checklist

- Signed in as `karli2000` (admin), you see all tabs (Reports, Live, Users, Bans, Audit, Admin).
- A non-staff GitHub account sees `You're not a moderator.`
- The report queue shows a test report.
- The live view shows a test message.
- The audit log lists the actions just taken.
- Signing out of the site does not sign out the Claude Code plugin (`/cbreak status` still shows you signed in).

## Known limits

- The report queue shows at most the 100 newest reports per status; older ones are not paged. Resolved reports are deleted after 90 days anyway; a backlog of more than 100 open reports would need paging.
- Integration tests run against the hosted project (`INTEGRATION_ALLOW_REMOTE=1`, see `docs/deploy.md`) delete their users and rooms, but they leave rows behind: `mod_actions` rows (they keep the deleted test users' ids, so the audit log shows `deleted user`) and reports (reporter and target become null, shown as `deleted user → deleted user`; open ones stay in the Open queue until someone dismisses them). Audit rows expire after 1 year, resolved reports 90 days after resolving.
