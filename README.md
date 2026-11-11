# Coffee Break

Supabase-backed chat backend for a Claude Code plugin. All logic lives in Postgres (RLS tables plus `SECURITY DEFINER` RPCs) and Supabase Realtime.

Requires Bun and Docker.

```sh
bun install
bun run db:start   # start the local Supabase stack
bun run db:test    # reset the db and run pgTAP tests
bun run test:int   # realtime integration tests (bun test tests/integration)
```
