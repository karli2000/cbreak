# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
[open a private report](https://github.com/karli2000/cbreak/security/advisories/new) (GitHub → Security → Report a vulnerability).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer within a few days. Please give us a chance to fix the problem before you talk about it publicly.

## Scope

- The Claude Code plugin (`plugin/`): the mod and the helper `cbreakd`
- The backend: the Supabase database functions, policies and the `github-age` function (`supabase/`)
- The moderator site https://mod.cbreak.dev (`site/`) and the homepage https://cbreak.dev (`web/`)

Out of scope: denial of service by volume, reports from automated scanners without a working example, and problems in Supabase, Cloudflare, GitHub or Claude Code themselves (report those to their vendors).

## Supported versions

Only the latest plugin version gets fixes. Update with `claude plugin marketplace update cbreak` and `claude plugin update cbreak@cbreak`.
