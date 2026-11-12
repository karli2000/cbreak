import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@supabase/supabase-js";
import { AuthStore, ensureFreshSession, persistRefreshes } from "../../plugin/helper/auth";

let root: string, dir: string, store: AuthStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cb-ef-")); dir = join(root, "d"); store = new AuthStore(dir); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mk = (access: string, refresh: string, exp: number) =>
  ({ access_token: access, refresh_token: refresh, expires_at: exp, expires_in: 3600, token_type: "bearer", user: {} }) as unknown as Session;
const now = () => Math.floor(Date.now() / 1000);

function stub(current: Session | null, refreshResult: { data?: { session: Session }; error?: object }) {
  const calls = { refresh: 0, lockHeld: false, setAuth: [] as string[], refreshTokens: [] as string[], fileAtRefresh: null as Session | null };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: current } }),
      setSession: async () => ({ error: null }),
      refreshSession: async (arg: { refresh_token: string }) => {
        calls.refresh++;
        calls.refreshTokens.push(arg.refresh_token);
        calls.fileAtRefresh = await store.read();
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

test("a newer in-memory session wins over an older file: its refresh token is used and persisted first", async () => {
  const onDisk = mk("a1", "r1", now() - 300); // stale copy (memory was refreshed without reaching the file)
  await store.write(onDisk);
  const mem = mk("a2", "r2", now() - 100);
  const fresh = mk("a3", "r3", now() + 3600);
  const { client, calls } = stub(mem, { data: { session: fresh } });
  expect(await ensureFreshSession(client, store, 120)).toEqual(fresh);
  expect(calls.refreshTokens).toEqual(["r2"]);
  expect(calls.fileAtRefresh).toEqual(mem); // persisted before spending it
  expect(await store.read()).toEqual(fresh);
});

test("a newer in-memory session is kept on disk when its refresh fails transiently", async () => {
  await store.write(mk("a1", "r1", now() - 300));
  const mem = mk("a2", "r2", now() - 100);
  const { client } = stub(mem, { error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } });
  await expect(ensureFreshSession(client, store, 120)).rejects.toMatchObject({ code: "network" });
  expect(await store.read()).toEqual(mem);
});

test("persistRefreshes writes sessions from TOKEN_REFRESHED and SIGNED_IN, ignores other events", async () => {
  let cb: ((event: string, s: Session | null) => void) | null = null;
  const client = { auth: { onAuthStateChange: (f: typeof cb) => { cb = f; return { data: { subscription: { unsubscribe() {} } } }; } } };
  persistRefreshes(client as any, store);
  const s1 = mk("a1", "r1", now() + 900);
  cb!("TOKEN_REFRESHED", s1);
  await Bun.sleep(20);
  expect(await store.read()).toEqual(s1);
  const s2 = mk("a2", "r2", now() + 900);
  cb!("SIGNED_IN", s2);
  await Bun.sleep(20);
  expect(await store.read()).toEqual(s2);
  cb!("SIGNED_OUT", null);
  cb!("USER_UPDATED", mk("a3", "r3", now() + 900));
  await Bun.sleep(20);
  expect(await store.read()).toEqual(s2);
});

test("persistRefreshes skips a session the store already wrote (no second write racing the first)", async () => {
  let cb: ((event: string, s: Session | null) => void) | null = null;
  const client = { auth: { onAuthStateChange: (f: typeof cb) => { cb = f; return { data: { subscription: { unsubscribe() {} } } }; } } };
  persistRefreshes(client as any, store);
  const s1 = mk("a1", "r1", now() + 900);
  await store.write(s1);
  let writes = 0;
  const orig = store.write.bind(store);
  store.write = async (s: Session) => { writes++; return orig(s); };
  cb!("TOKEN_REFRESHED", s1);
  await Bun.sleep(20);
  expect(writes).toBe(0);
  const s2 = mk("a2", "r2", now() + 900);
  cb!("TOKEN_REFRESHED", s2);
  await Bun.sleep(20);
  expect(writes).toBe(1);
  expect(await store.read()).toEqual(s2);
});

test("usableWithoutRefresh: only sessions valid for more than 120 s (auth-js refreshes inside 90 s)", async () => {
  const { usableWithoutRefresh } = await import("../../plugin/helper/auth");
  const t = 1_800_000_000_000;
  const s = (expS: number) => mk("a", "r", expS);
  expect(usableWithoutRefresh(s(t / 1000 + 3600), t)).toBe(true);
  expect(usableWithoutRefresh(s(t / 1000 + 121), t)).toBe(true);
  expect(usableWithoutRefresh(s(t / 1000 + 120), t)).toBe(false);
  expect(usableWithoutRefresh(s(t / 1000 + 60), t)).toBe(false);
  expect(usableWithoutRefresh(s(t / 1000 - 10), t)).toBe(false);
});
