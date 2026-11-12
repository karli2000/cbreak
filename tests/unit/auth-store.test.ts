import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@supabase/supabase-js";
import { AuthStore, authFileName } from "../../plugin/helper/auth";
import { SUPABASE_URL } from "../../plugin/shared/backend";

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
  expect(existsSync(lock)).toBe(false);
});

test("the auth file is per backend: auth.json for the hosted project, auth-<host>.json otherwise", () => {
  expect(authFileName(SUPABASE_URL)).toBe("auth.json");
  expect(authFileName(SUPABASE_URL + "/")).toBe("auth.json");
  expect(authFileName("http://127.0.0.1:54321")).toBe("auth-127.0.0.1_54321.json");
});

test("a login for another backend neither reads nor touches the hosted one", async () => {
  const hosted = new AuthStore(dir, SUPABASE_URL);
  const local = new AuthStore(dir, "http://127.0.0.1:54321");
  const other = { ...sess, access_token: "local" } as Session;
  await hosted.write(sess);
  expect(await local.read()).toBeNull();
  await local.write(other);
  expect(await hosted.read()).toEqual(sess);
  expect(await local.read()).toEqual(other);
  await local.clear();
  expect(await hosted.read()).toEqual(sess);
});

test("a file stored for another URL reads as signed out and is left alone", async () => {
  const hosted = new AuthStore(dir, SUPABASE_URL);
  await hosted.write(sess);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, url: "http://elsewhere:1", session: sess }));
  expect(await hosted.read()).toBeNull();
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, session: sess })); // no url
  expect(await hosted.read()).toBeNull();
  expect(existsSync(join(dir, "auth.json"))).toBe(true);
});

test("concurrent writes never collide and the last write wins", async () => {
  const sessions = Array.from({ length: 50 }, (_, i) => ({ ...sess, access_token: `a${i}`, refresh_token: `r${i}` }) as Session);
  await Promise.all(sessions.map((s) => store.write(s)));
  expect(await store.read()).toEqual(sessions.at(-1)!);
  // no leftover tmp files
  expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("written() reports the refresh token on file; clear() forgets it", async () => {
  expect(store.written("r")).toBe(false);
  await store.write(sess);
  expect(store.written("r")).toBe(true);
  await store.clear();
  expect(store.written("r")).toBe(false);
});
