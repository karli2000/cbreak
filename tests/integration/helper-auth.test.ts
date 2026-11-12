import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, authState, createHelperClient, ensureFreshSession } from "../../plugin/helper/auth";
import { bareUser, cleanup, env, runId, userClient } from "./_env";

const dirs: string[] = [];
afterAll(async () => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  await cleanup();
});

test("authState reports ready for a set-up user", async () => {
  const u = await userClient("ha");
  expect(await authState(u)).toEqual({ state: "ready", nickname: `ha_${runId}`, role: "user", muted_until: null });
});

test("authState reports needs_nickname without a profile", async () => {
  expect(await authState(await bareUser())).toEqual({ state: "needs_nickname" });
});

test("authState reports signed_out without a session", async () => {
  expect(await authState(createHelperClient(env().url, env().anonKey))).toEqual({ state: "signed_out" });
});

test("two stores refreshing concurrently share one refresh", async () => {
  const u = await userClient("hr");
  const original = (await u.auth.getSession()).data.session!;
  const dir = mkdtempSync(join(tmpdir(), "cb-int-"));
  dirs.push(dir);
  await new AuthStore(dir).write(original);

  const mk = async () => {
    const c = createHelperClient(env().url, env().anonKey);
    const { error } = await c.auth.setSession({ access_token: original.access_token, refresh_token: original.refresh_token });
    expect(error).toBeNull();
    return c;
  };
  const [a, b] = [await mk(), await mk()];
  const [ra, rb] = await Promise.all([
    ensureFreshSession(a, new AuthStore(dir), 10_000),
    ensureFreshSession(b, new AuthStore(dir), 10_000),
  ]);
  expect(ra).not.toBeNull();
  expect(rb).not.toBeNull();
  expect(ra!.refresh_token).toBe(rb!.refresh_token);
  expect(ra!.refresh_token).not.toBe(original.refresh_token);
  expect((await a.rpc("my_profile")).error).toBeNull();
  expect((await b.rpc("my_profile")).error).toBeNull();
});
