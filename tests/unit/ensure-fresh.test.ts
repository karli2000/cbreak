import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@supabase/supabase-js";
import { AuthStore, ensureFreshSession } from "../../plugin/helper/auth";

let root: string, dir: string, store: AuthStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cb-ef-")); dir = join(root, "d"); store = new AuthStore(dir); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mk = (access: string, refresh: string, exp: number) =>
  ({ access_token: access, refresh_token: refresh, expires_at: exp, expires_in: 3600, token_type: "bearer", user: {} }) as unknown as Session;
const now = () => Math.floor(Date.now() / 1000);

function stub(current: Session | null, refreshResult: { data?: { session: Session }; error?: object }) {
  const calls = { refresh: 0, lockHeld: false, setAuth: [] as string[] };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: current } }),
      setSession: async () => ({ error: null }),
      refreshSession: async () => {
        calls.refresh++;
        calls.lockHeld = existsSync(join(dir, "auth.lock"));
        return refreshResult.error ? { data: { session: null }, error: refreshResult.error } : { data: refreshResult.data, error: null };
      },
    },
    realtime: { setAuth: async (t: string) => void calls.setAuth.push(t) },
  };
  return { client: client as any, calls };
}

test("an expired client session is refreshed under the lock and persisted", async () => {
  const expired = mk("old", "r1", now() - 100);
  await store.write(expired);
  const fresh = mk("new", "r2", now() + 3600);
  const { client, calls } = stub(expired, { data: { session: fresh } });
  const res = await ensureFreshSession(client, store, 120);
  expect(res).toEqual(fresh);
  expect(calls.refresh).toBe(1);
  expect(calls.lockHeld).toBe(true);
  expect(await store.read()).toEqual(fresh);
  expect(calls.setAuth).toEqual(["new"]);
});

test("a revoked refresh token clears the stored login", async () => {
  const expired = mk("old", "r1", now() - 100);
  await store.write(expired);
  const { client } = stub(expired, { error: { name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "x" } });
  expect(await ensureFreshSession(client, store, 120)).toBeNull();
  expect(await store.read()).toBeNull();
});

test("retryable refresh errors keep the file and throw network", async () => {
  for (const error of [
    { name: "AuthApiError", status: 503, message: "down" },
    { name: "AuthApiError", status: 429, message: "slow down" },
    { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
  ]) {
    const expired = mk("old", "r1", now() - 100);
    await store.write(expired);
    const { client } = stub(expired, { error });
    await expect(ensureFreshSession(client, store, 120)).rejects.toMatchObject({ code: "network" });
    expect(await store.read()).toEqual(expired);
  }
});
