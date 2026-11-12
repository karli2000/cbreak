# Moderator site

Static React + Vite app in `site/` (supabase-js in the browser, no server code, no service-role key). It is hosted on Cloudflare Pages as project `coffeebreak-mod` (default URL `https://coffeebreak-mod.pages.dev`).

## Local dev

```bash
bunx supabase status          # copy API URL and anon key
export VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=<anon key>
bun run site:dev              # http://localhost:5173
```

Without the two variables the site uses the hosted backend from `plugin/shared/backend.ts`.

## Build

```bash
bun run site:build            # output in site/dist
bun run test:site             # includes a real build and checks dist (headers, no secrets, no inline script/style)
```

`site/public/_headers` is copied to `dist/_headers`; Cloudflare Pages applies it (CSP, nosniff, no-referrer, Permissions-Policy). The CSP allows only `'self'` plus the hosted Supabase project (https and wss). If the backend URL changes, update `_headers`.

## Deploy

```bash
bunx wrangler login           # once
bun run site:deploy           # builds, then wrangler pages deploy site/dist --project-name coffeebreak-mod
```

A custom domain is optional (Pages dashboard, Custom domains). A public imprint waits for a public launch.

## Owner steps, in order

1. `bunx supabase db push --remote` (applies `20261112000100_moderator_site.sql`: `mod_list_banned`, `admin_list_staff`, `admin_unban_github_id`).
2. Supabase dashboard, Authentication, URL Configuration, Redirect URLs: add `https://coffeebreak-mod.pages.dev/**` and `http://localhost:5173/**`. Keep the existing entries.
3. `bunx wrangler login`, then `bun run site:deploy`.

## Owner checklist

- Signed in as `karli2000` (admin), you see all tabs (Reports, Live, Users, Bans, Audit, Admin).
- A non-staff GitHub account sees `You're not a moderator.`
- The report queue shows a test report.
- The live view shows a test message.
- The audit log lists the actions just taken.
