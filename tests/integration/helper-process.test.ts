import { afterAll, beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { adminClient, bareUser, runId, setup, teardown, testRoom, userClient } from "./_env";
import { cleanupHelpers, makeDataDir, startHelper } from "./_helper";

beforeAll(setup, 60_000);
afterAll(async () => {
  cleanupHelpers();
  await teardown();
});

const sessionOf = async (u: { auth: { getSession(): Promise<{ data: { session: any } }> } }) =>
  (await u.auth.getSession()).data.session!;

test("says hello and reports auth", async () => {
  const u = await userClient("hp1");
  const h = await startHelper({ session: await sessionOf(u) });
  expect(statSync(h.socket).isSocket()).toBe(true);
  const ev = await h.waitFor("auth");
  expect(ev).toMatchObject({ type: "auth", state: "ready", nickname: `hp1_${runId}` });
  expect(await h.stop()).toBe(0);

  const h2 = await startHelper();
  expect(await h2.waitFor("auth")).toMatchObject({ state: "signed_out" });
  await h2.stop();
});

test("ping and status work signed out; other routes do not", async () => {
  const h = await startHelper();
  expect(await h.call("/ping")).toEqual({ ok: true, data: {} });
  expect(await h.call("/status")).toEqual({ ok: true, data: { auth: { state: "signed_out" }, room: null } });
  expect(await h.call("/nickname/check", { nick: "abc" })).toMatchObject({ ok: false, code: "not_signed_in" });
  await h.stop();
});

test("unknown path is 404 and bad json is 400", async () => {
  const h = await startHelper();
  const res = await fetch("http://localhost/nope", { unix: h.socket, method: "POST", body: "{}" } as RequestInit);
  expect(res.status).toBe(404);
  const bad = await fetch("http://localhost/ping", { unix: h.socket, method: "POST", body: "{nope" } as RequestInit);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ ok: false, code: "bad_request" });
  await h.stop();
});

test("claims a nickname and accepts rules", async () => {
  const u = await bareUser();
  const h = await startHelper({ session: await sessionOf(u) });
  expect(await h.waitFor("auth")).toMatchObject({ state: "needs_nickname" });
  const nick = `hp_${runId}`;
  expect(await h.call("/nickname/check", { nick })).toEqual({ ok: true, data: { available: true } });
  expect(await h.call("/nickname/claim", { nick })).toEqual({ ok: true, data: { nickname: nick } });
  expect(await h.waitFor("auth")).toMatchObject({ state: "needs_rules", nickname: nick });
  expect(await h.call("/rules/accept")).toEqual({ ok: true, data: {} });
  expect(await h.waitFor("auth")).toMatchObject({ state: "ready", nickname: nick });
  await h.stop();
});

test("maps RPC errors to codes", async () => {
  const u = await bareUser();
  const h = await startHelper({ session: await sessionOf(u) });
  await h.waitFor("auth");
  expect(await h.call("/nickname/claim", { nick: "admin" })).toMatchObject({ ok: false, code: "nickname_reserved" });
  await h.stop();
});

test("writes auth.json with mode 600 and logout clears it", async () => {
  const u = await userClient("hp2");
  const h = await startHelper({ session: await sessionOf(u) });
  await h.waitFor("auth");
  const f = join(h.dataDir, "auth.json");
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(await h.call("/logout")).toEqual({ ok: true, data: {} });
  expect(await h.waitFor("auth")).toMatchObject({ state: "signed_out" });
  expect(() => statSync(f)).toThrow();
  await h.stop();
});

test("exits and leaves after idle timeout", async () => {
  const u = await userClient("hp3");
  const h = await startHelper({ session: await sessionOf(u), env: { COFFEEBREAK_IDLE_EXIT_MS: "1500" } });
  await h.waitFor("auth");
  const a = adminClient();
  const { error } = await a.from("occupancy").insert({ user_id: u.userId, room: testRoom, instance: 1 });
  expect(error).toBeNull();
  const code = await Promise.race([h.proc.exited, Bun.sleep(5000).then(() => "timeout")]);
  expect(code).toBe(0);
  const { data } = await a.from("occupancy").select("user_id").eq("user_id", u.userId);
  expect(data).toEqual([]);
});

test("exits when its parent dies", async () => {
  const main = join(import.meta.dir, "../../plugin/helper/main.ts");
  const out = join(makeDataDir(), "out.ndjson");
  const sh = Bun.spawn(["sh", "-c", `bun ${main} >${out} & echo $!; wait`], {
    stdout: "pipe",
    env: { ...process.env, COFFEEBREAK_DATA_DIR: makeDataDir(), COFFEEBREAK_NO_BROWSER: "1" },
  });
  const reader = (sh.stdout as ReadableStream<Uint8Array>).getReader();
  const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
  expect(pid).toBeGreaterThan(1);
  for (let i = 0; i < 100 && !(await Bun.file(out).text().catch(() => "")).includes("hello"); i++) await Bun.sleep(100);
  process.kill(pid, 0); // alive
  sh.kill("SIGKILL");
  const deadline = Date.now() + 5000;
  let dead = false;
  while (Date.now() < deadline && !dead) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(100);
    } catch {
      dead = true;
    }
  }
  if (!dead) process.kill(pid, "SIGKILL");
  expect(dead).toBe(true);
});

test("SIGTERM exits 0 and removes the socket", async () => {
  const h = await startHelper();
  expect(statSync(h.socket).isSocket()).toBe(true);
  expect(await h.stop()).toBe(0);
  expect(() => statSync(h.socket)).toThrow();
});
