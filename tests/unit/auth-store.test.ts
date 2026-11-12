import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@supabase/supabase-js";
import { AuthStore } from "../../plugin/helper/auth";

let root: string, dir: string, store: AuthStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cb-auth-"));
  dir = join(root, "data");
  store = new AuthStore(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sess = { access_token: "a", refresh_token: "r", expires_in: 3600, expires_at: 1, token_type: "bearer", user: {} } as unknown as Session;

test("write then read round-trips", async () => {
  await store.write(sess);
  expect(await store.read()).toEqual(sess);
});

test("modes are 600 for the file and 700 for the dir", async () => {
  await store.write(sess);
  expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("read of garbage or a wrong version is null; clear removes the file", async () => {
  await store.write(sess);
  writeFileSync(join(dir, "auth.json"), "not json");
  expect(await store.read()).toBeNull();
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 2, session: sess }));
  expect(await store.read()).toBeNull();
  await store.clear();
  expect(existsSync(join(dir, "auth.json"))).toBe(false);
});

test("concurrent withLock bodies never overlap", async () => {
  const log: string[] = [];
  const body = async () => { log.push("in"); await Bun.sleep(150); log.push("out"); };
  await Promise.all([store.withLock(body), new AuthStore(dir).withLock(body)]);
  expect(log).toEqual(["in", "out", "in", "out"]);
  expect(existsSync(join(dir, "auth.lock"))).toBe(false);
});

test("a stale lock is taken over", async () => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "auth.lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);
  expect(await store.withLock(async () => "ok")).toBe("ok");
});
