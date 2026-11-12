// Data layer of the moderator site (site/src/api.ts) against the local stack.
// Uses the per-run rooms from setup(); never touches real rooms.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import * as api from "../../site/src/api";
import { adminClient, bareUser, otherRoom, setup, teardown, testRoom, userClient, type TestUser } from "./_env";

setDefaultTimeout(20_000);

beforeAll(setup, 60_000);
afterAll(teardown);

async function check<T extends { error: unknown }>(p: PromiseLike<T>, what: string): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(`${what}: ${JSON.stringify(res.error)}`);
  return res;
}

async function aged(nick: string, role: "user" | "moderator" | "admin" = "user"): Promise<TestUser> {
  const u = await userClient(nick, role);
  await check(
    adminClient().from("profiles").update({ github_created_at: "2020-01-01T00:00:00Z" }).eq("id", u.userId),
    "age user",
  );
  return u;
}

/** B joins the test room and sends `body`; returns the message id. */
async function say(u: TestUser, body: string): Promise<number> {
  await check(u.rpc("join_room", { room_slug: testRoom }), "join_room");
  const { data } = await check(u.rpc("send_message", { body }), "send_message");
  return (data as { id: number }).id;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(api.ApiError);
    return (e as api.ApiError).code;
  }
  throw new Error("expected ApiError");
};

async function until<T>(f: () => T | undefined, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = f();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  return f();
}

test("me returns the role and null without a profile", async () => {
  const mod = await userClient("me", "moderator");
  expect(await api.me(mod)).toEqual({
    id: mod.userId,
    nickname: mod.nickname,
    role: "moderator",
    banned: false,
  });
  expect(await api.me(await bareUser())).toBeNull();
});

test("listReports returns an open report with its snapshot", async () => {
  const mod = await userClient("lr_mod", "moderator");
  const a = await userClient("lr_a");
  const b = await aged("lr_b");
  const id = await say(b, "snapshot body 1");
  const { data: rid } = await check(
    a.rpc("report_user", { target_nickname: b.nickname, message_id: id, reason: "spam" }),
    "report",
  );
  const reports = await api.listReports(mod, "open");
  const r = reports.find((x) => x.id === Number(rid));
  expect(r).toBeDefined();
  expect(r!.snapshot.message?.body).toBe("snapshot body 1");
  expect(r!.status).toBe("open");
  expect(r!.target_id).toBe(b.userId);
});

test("resolveReport moves it to dismissed", async () => {
  const mod = await userClient("rr_mod", "moderator");
  const a = await userClient("rr_a");
  const b = await userClient("rr_b");
  const { data: rid } = await check(
    a.rpc("report_user", { target_nickname: b.nickname, message_id: null, reason: "meh" }),
    "report",
  );
  await api.resolveReport(mod, Number(rid), "dismissed");
  expect((await api.listReports(mod, "dismissed")).some((x) => x.id === Number(rid))).toBe(true);
  expect((await api.listReports(mod, "open")).some((x) => x.id === Number(rid))).toBe(false);
});

test("mute and unmute through the api", async () => {
  const mod = await userClient("mu_mod", "moderator");
  const b = await userClient("mu_b");
  const mutedUntil = async () =>
    (await check(adminClient().from("profiles").select("muted_until").eq("id", b.userId).single(), "read"))
      .data!.muted_until;
  await api.mute(mod, b.userId, 10, "test");
  expect(await mutedUntil()).not.toBeNull();
  await api.unmute(mod, b.userId, "test");
  expect(await mutedUntil()).toBeNull();
});

test("forbidden maps to ApiError code forbidden", async () => {
  const m1 = await userClient("fb_m1", "moderator");
  const m2 = await userClient("fb_m2", "moderator");
  expect(await code(api.mute(m1, m2.userId, 10, "x"))).toBe("forbidden");
});

test("ban, listBanned, unban", async () => {
  const mod = await userClient("bn_mod", "moderator");
  const admin = await userClient("bn_admin", "admin");
  const b = await userClient("bn_b");
  await api.ban(mod, b.userId, "bad");
  const banned = await api.listBanned(mod);
  expect(banned.find((x) => x.id === b.userId)).toMatchObject({ nickname: b.nickname, ban_reason: "bad" });
  expect(await code(api.unban(mod, b.userId, "no"))).toBe("forbidden");
  await api.unban(admin, b.userId, "ok");
  expect((await api.listBanned(mod)).some((x) => x.id === b.userId)).toBe(false);
});

test("listActions filters by action and pages with before", async () => {
  const mod = await userClient("la_mod", "moderator");
  const b = await userClient("la_b");
  await api.mute(mod, b.userId, 10, "one");
  await Bun.sleep(20);
  await api.unmute(mod, b.userId, "two");
  await Bun.sleep(20);
  await api.mute(mod, b.userId, 60, "three");
  const mutes = await api.listActions(mod, { action: "mod_mute", targetId: b.userId });
  expect(mutes.map((a) => a.reason)).toEqual(["three", "one"]);
  expect(mutes.every((a) => a.action === "mod_mute")).toBe(true);
  const all = await api.listActions(mod, { targetId: b.userId, actorId: mod.userId });
  expect(all.map((a) => a.reason)).toEqual(["three", "two", "one"]);
  const older = await api.listActions(mod, { targetId: b.userId }, 50);
  const page = await api.listActions(mod, { targetId: b.userId, before: { created_at: older[0]!.created_at, id: older[0]!.id } });
  expect(page.map((a) => a.reason)).toEqual(["two", "one"]);
});

test("listActions cursor does not skip actions sharing a created_at", async () => {
  const mod = await userClient("lc_mod", "moderator");
  const b = await userClient("lc_b");
  await api.mute(mod, b.userId, 10, "a");
  await api.mute(mod, b.userId, 10, "b");
  await api.mute(mod, b.userId, 10, "c");
  const rows = await api.listActions(mod, { targetId: b.userId });
  expect(rows.map((a) => a.reason)).toEqual(["c", "b", "a"]);
  // Give all three the same timestamp (service role), then page one at a time.
  const ts = "2026-01-01T00:00:00.123456+00:00";
  const { error } = await adminClient().from("mod_actions").update({ created_at: ts }).in("id", rows.map((r) => r.id));
  expect(error).toBeNull();
  const p1 = await api.listActions(mod, { targetId: b.userId }, 1);
  const p2 = await api.listActions(mod, { targetId: b.userId, before: { created_at: p1[0]!.created_at, id: p1[0]!.id } }, 1);
  const p3 = await api.listActions(mod, { targetId: b.userId, before: { created_at: p2[0]!.created_at, id: p2[0]!.id } }, 1);
  const p4 = await api.listActions(mod, { targetId: b.userId, before: { created_at: p3[0]!.created_at, id: p3[0]!.id } }, 1);
  expect([p1, p2, p3].map((p) => p[0]!.reason)).toEqual(["c", "b", "a"]);
  expect(p4).toEqual([]);
  expect(p1[0]!.created_at).toContain(".123456");
  // A row one microsecond earlier must still come after the tied ones, and later ones must not leak in.
  const { error: e2 } = await adminClient().from("mod_actions").update({ created_at: "2026-01-01T00:00:00.123455+00:00" }).eq("id", rows[2]!.id);
  expect(e2).toBeNull();
  const q1 = await api.listActions(mod, { targetId: b.userId }, 2);
  const q2 = await api.listActions(mod, { targetId: b.userId, before: { created_at: q1[1]!.created_at, id: q1[1]!.id } }, 2);
  expect(q1.map((a) => a.reason)).toEqual(["c", "b"]);
  expect(q2.map((a) => a.reason)).toEqual(["a"]);
});

test("names resolves ids in one call", async () => {
  const mod = await userClient("nm_mod", "moderator");
  const b = await userClient("nm_b");
  const m = await api.names(mod, [mod.userId, b.userId]);
  expect(m.get(b.userId)).toEqual({ nickname: b.nickname, role: "user" });
  expect(m.get(mod.userId)?.role).toBe("moderator");
  expect((await api.names(mod, [])).size).toBe(0);
});

test("lookupUser returns profile, reports and actions", async () => {
  const mod = await userClient("lu_mod", "moderator");
  const a = await userClient("lu_a");
  const b = await userClient("lu_b");
  await check(a.rpc("report_user", { target_nickname: b.nickname, message_id: null, reason: "r" }), "report");
  await api.mute(mod, b.userId, 10, "why");
  const u = await api.lookupUser(mod, b.nickname);
  expect(u.profile).toMatchObject({ id: b.userId, nickname: b.nickname, role: "user" });
  expect(u.reports_against).toHaveLength(1);
  expect(u.actions_against.some((x) => x.action === "mod_mute")).toBe(true);
  expect(await code(api.lookupUser(mod, "nobody_here_xx"))).toBe("not_found");
});

test("listStaff and setRole (admin)", async () => {
  const admin = await userClient("st_admin", "admin");
  const b = await userClient("st_b");
  await api.setRole(admin, b.userId, "moderator");
  const staff = await api.listStaff(admin);
  expect(staff.find((s) => s.id === b.userId)).toMatchObject({ nickname: b.nickname, role: "moderator" });
  expect(staff.find((s) => s.id === admin.userId)?.role).toBe("admin");
  await api.setRole(admin, b.userId, "user");
  expect((await api.listStaff(admin)).some((s) => s.id === b.userId)).toBe(false);
});

test("rooms and filters (admin)", async () => {
  const admin = await userClient("rf_admin", "admin");
  await api.upsertRoom(admin, { slug: otherRoom, title: "Renamed by test", kind: "public", lang: null, is_open: true });
  const rooms = await api.listRooms(admin);
  expect(rooms.find((r) => r.slug === otherRoom)?.title).toBe("Renamed by test");
  const pattern = `zzfilter${Math.random().toString(36).slice(2, 8)}`;
  const id = await api.addFilter(admin, pattern);
  expect((await api.listFilters(admin)).some((f) => f.id === id && f.pattern === pattern)).toBe(true);
  await api.removeFilter(admin, id);
  expect((await api.listFilters(admin)).some((f) => f.id === id)).toBe(false);
  expect(await code(api.addFilter(admin, "("))).toBe("invalid_pattern");
});

test("watchRoom receives a message and a deletion", async () => {
  const mod = await userClient("wr_mod", "moderator");
  const a = await aged("wr_a");
  await check(a.rpc("join_room", { room_slug: testRoom }), "join");
  const got: api.ChatMessage[] = [];
  const deleted: number[] = [];
  let status = "";
  const stop = api.watchRoom(mod, testRoom, 1, {
    message: (m) => got.push(m),
    deleted: (id) => deleted.push(id),
    status: (s) => (status = s),
  });
  try {
    expect(await until(() => (status === "live" ? true : undefined), 15_000)).toBe(true);
    const { data } = await check(a.rpc("send_message", { body: "watch me" }), "send");
    const id = (data as { id: number }).id;
    const m = await until(() => got.find((x) => x.id === id));
    expect(m).toMatchObject({ body: "watch me", nickname: a.nickname, user_id: a.userId });
    await api.deleteMessage(mod, id, "test");
    expect(await until(() => (deleted.includes(id) ? true : undefined))).toBe(true);
  } finally {
    stop();
  }
});

test("recentMessages returns the instance's messages oldest first", async () => {
  const mod = await userClient("rm_mod", "moderator");
  const a = await aged("rm_a");
  const first = await say(a, "recent one");
  await Bun.sleep(2100);
  const second = await say(a, "recent two");
  const msgs = await api.recentMessages(mod, testRoom, 1);
  const ids = msgs.map((m) => m.id);
  expect(ids.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
  expect(ids).toEqual([...ids].sort((x, y) => x - y));
  const counts = await api.roomCounts(mod);
  expect(counts.find((r) => r.room === testRoom && r.instance === 1)?.here).toBeGreaterThanOrEqual(1);
});

test("transport failure maps to network", async () => {
  // 127.0.0.1:9 is silently dropped (not refused) in some environments (WSL), which would hang;
  // a fetch that rejects the way a refused connection does keeps this deterministic.
  const failing = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  const c = createClient("http://127.0.0.1:9", "anon-key-not-used", {
    auth: { persistSession: false },
    global: { fetch: failing },
  });
  expect(await code(api.listRooms(c))).toBe("network");
  expect(await code(api.me(c))).toBe("network");
});

test("invites round-trip (admin)", async () => {
  const admin = await userClient("invadm", "admin");
  const before = await api.inviteOnly(admin);
  const ghId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  try {
    await api.addInvite(admin, ghId, "Inv-Test", "a note");
    let rows = await api.listInvites(admin);
    expect(rows.find((r) => r.github_id === ghId)).toMatchObject({ github_login: "Inv-Test", note: "a note" });
    await api.addInvite(admin, ghId, "inv-test", null);
    rows = await api.listInvites(admin);
    expect(rows.filter((r) => r.github_id === ghId).length).toBe(1);
    expect(rows.find((r) => r.github_id === ghId)?.note).toBeNull();
    const times = rows.map((r) => r.created_at);
    expect(times).toEqual([...times].sort().reverse());

    await api.setInviteOnly(admin, !before);
    expect(await api.inviteOnly(admin)).toBe(!before);
    await api.setInviteOnly(admin, before);
    expect(await api.inviteOnly(admin)).toBe(before);

    await api.removeInvite(admin, ghId);
    expect((await api.listInvites(admin)).some((r) => r.github_id === ghId)).toBe(false);
    expect(await code(api.removeInvite(admin, ghId))).toBe("not_found");
    expect(await code(api.addInvite(admin, ghId, "   ", null))).toBe("invalid_login");
  } finally {
    await adminClient().from("beta_invites").delete().eq("github_id", ghId);
    await adminClient().from("beta_settings").update({ invite_only: before }).eq("id", true);
  }
});

test("invites are admin-only", async () => {
  const mod = await userClient("invmod", "moderator");
  expect(await code(api.addInvite(mod, 1, "x", null))).toBe("forbidden");
  expect(await api.listInvites(mod)).toEqual([]);
});
