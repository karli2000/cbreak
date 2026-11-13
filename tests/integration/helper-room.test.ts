// Room session of the real helper process: join, relay, presence, re-join, kick, moderation.
// All joins use the per-run `testRoom`, never real rooms.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { HelperEvent } from "../../plugin/shared/protocol";
import { adminClient, setup, teardown, testRoom, userClient, type TestUser } from "./_env";
import { cleanupHelpers, startHelper, type StartedHelper } from "./_helper";

// unauthorized joins take ~5 s to come back as CHANNEL_ERROR; re-join paths wait for ticks
setDefaultTimeout(20_000);

beforeAll(setup, 60_000);
afterAll(async () => {
  cleanupHelpers();
  await teardown();
});

const topic1 = `room:${testRoom}:1`;

async function check<T extends { error: unknown }>(p: PromiseLike<T>, what: string): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(`${what}: ${JSON.stringify(res.error)}`);
  return res;
}

/** A ready user whose GitHub account counts as old (2 s rate limit instead of 10 s). */
async function agedUser(nick: string, role: "user" | "moderator" = "user"): Promise<TestUser> {
  const u = await userClient(nick, role);
  await check(
    adminClient().from("profiles").update({ github_created_at: "2020-01-01T00:00:00Z" }).eq("id", u.userId),
    "age user",
  );
  return u;
}

const sessionOf = async (u: TestUser) => (await u.auth.getSession()).data.session!;

/** Starts a helper for `u` and waits for its first auth event. */
async function helperFor(u: TestUser, env?: Record<string, string>): Promise<StartedHelper> {
  const h = await startHelper({ session: await sessionOf(u), env });
  expect(await h.waitFor("auth")).toMatchObject({ state: "ready" });
  return h;
}

/** Starts a helper for a new user A and joins `testRoom`. */
async function joinedA(nick: string, env?: Record<string, string>) {
  const a = await agedUser(nick);
  const h = await helperFor(a, env);
  const res = await h.call("/join", { room: testRoom });
  expect(res).toMatchObject({ ok: true, data: { room: testRoom, topic: topic1 } });
  await h.waitFor("joined");
  await h.waitFor("backlog");
  return { a, h };
}

/** A plain supabase-js member B: join_room, then subscribe (and track) the private channel. */
async function memberB(user: TestUser, track = false) {
  const { data } = await check(user.rpc("join_room", { room_slug: testRoom }), "B join_room");
  const topic = (data as { topic: string }).topic;
  const received: { event: string; payload: Record<string, unknown> }[] = [];
  const channel: RealtimeChannel = user
    .channel(topic, { config: { private: true, presence: { key: user.userId } } })
    .on("broadcast", { event: "*" }, (m) => received.push({ event: m.event, payload: m.payload }))
    .on("presence", { event: "sync" }, () => {});
  const status = await new Promise<string>((r) => channel.subscribe((s) => r(s)));
  expect(status).toBe("SUBSCRIBED");
  if (track) expect(await channel.track({})).toBe("ok");
  return { topic, channel, received };
}

async function until<T>(f: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = f();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  return f();
}

const send = async (u: TestUser, body: string) =>
  (await check(u.rpc("send_message", { body }), `send ${body}`)).data as { id: number };

const occupancyOf = async (userId: string) =>
  (await check(adminClient().from("occupancy").select("*").eq("user_id", userId), "occupancy")).data as {
    last_seen: string;
  }[];

test("join emits joined then backlog with earlier messages", async () => {
  const b = await agedUser("rb1");
  await check(b.rpc("join_room", { room_slug: testRoom }), "B join_room");
  await send(b, "earlier");

  const a = await agedUser("ra1");
  const h = await helperFor(a);
  const res = await h.call("/join", { room: testRoom });
  expect(res).toMatchObject({ ok: true, data: { room: testRoom, instance: 1, topic: topic1 } });
  const joined = await h.waitFor("joined");
  expect(joined.topic).toBe("room:" + testRoom + ":1");
  const backlog = await h.waitFor("backlog");
  const earlier = backlog.messages.find((m) => m.body === "earlier");
  expect(earlier).toMatchObject({ nickname: b.nickname, user_id: b.userId, role: "user" });
  // joined comes before backlog
  const types = h.events.map((e) => e.type);
  expect(types.indexOf("joined")).toBeLessThan(types.indexOf("backlog"));
  // oldest first
  const ids = backlog.messages.map((m) => m.id);
  expect([...ids].sort((x, y) => x - y)).toEqual(ids);
  expect(await h.call("/status")).toMatchObject({ ok: true, data: { room: { room: testRoom, topic: topic1 } } });
  await h.stop();
});

test("relays messages both ways", async () => {
  const { a, h } = await joinedA("ra2");
  const b = await agedUser("rb2");
  const mb = await memberB(b);

  const sent = await h.call("/send", { body: "hi from A" });
  expect(sent).toMatchObject({ ok: true });
  expect((sent as { data: { id: number } }).data.id).toBeGreaterThan(0);
  const got = await until(() => mb.received.find((r) => r.event === "message" && r.payload.body === "hi from A"), 3000);
  expect(got?.payload.user_id).toBe(a.userId);
  expect(await h.waitFor("message", (m) => m.body === "hi from A")).toMatchObject({ nickname: a.nickname });

  await send(b, "hi from B");
  expect(await h.waitFor("message", (m) => m.body === "hi from B")).toMatchObject({
    nickname: b.nickname,
    user_id: b.userId,
    role: "user",
  });
  await h.stop();
});

test("relays deletions", async () => {
  const { h } = await joinedA("ra3");
  const b = await agedUser("rb3");
  await memberB(b);
  const mod = await agedUser("rm3", "moderator");
  const msg = await send(b, "delete me");
  await h.waitFor("message", (m) => m.id === msg.id);
  await check(mod.rpc("mod_delete_message", { message_id: msg.id, reason: "test" }), "mod_delete_message");
  expect(await h.waitFor("deleted", (e) => e.id === msg.id)).toEqual({ type: "deleted", id: msg.id });
  await h.stop();
});

test("presence reports joins with nicknames", async () => {
  const { h } = await joinedA("ra4");
  const b = await agedUser("rb4");
  await memberB(b, true);
  const p = await h.waitFor("presence", (e) => e.joined.includes(b.nickname));
  expect(p.here).toBeGreaterThanOrEqual(2);
  await h.stop();
});

test("joining a populated room does not announce the members already there", async () => {
  const b = await agedUser("rb14");
  const c = await agedUser("rc14");
  await memberB(b, true);
  await memberB(c, true);
  await Bun.sleep(500);
  const { h } = await joinedA("ra14");
  await Bun.sleep(1000);
  // the initial presence state (it may come before the backlog): the count, no names
  const first = h.events.find((e) => e.type === "presence") as Extract<HelperEvent, { type: "presence" }> | undefined;
  expect(first).toMatchObject({ joined: [], left: [] });
  expect(first!.here).toBeGreaterThanOrEqual(2);
  const d = await agedUser("rd14");
  await memberB(d, true);
  await h.waitFor("presence", (e) => e.joined.includes(d.nickname));
  await Bun.sleep(500);
  const presences = h.events.filter((e) => e.type === "presence") as Extract<HelperEvent, { type: "presence" }>[];
  expect(presences.filter((e) => e.joined.includes(b.nickname) || e.joined.includes(c.nickname))).toEqual([]);
  expect(presences.filter((e) => e.joined.includes(d.nickname))).toHaveLength(1);
  await h.stop();
});

test("re-joins after its occupancy row was purged", async () => {
  const { a, h } = await joinedA("ra5", { COFFEEBREAK_TICK_MS: "1000" });
  // purge_expired deletes occupancy rows older than 90 s; the next heartbeat gets not_in_room
  await check(adminClient().from("occupancy").delete().eq("user_id", a.userId), "purge occupancy");
  expect(await h.waitFor("joined", undefined, 5000)).toMatchObject({ room: testRoom, topic: topic1 });
  await h.waitFor("backlog");
  expect(await h.call("/send", { body: "back again" })).toMatchObject({ ok: true });
  expect(await h.waitFor("message", (m) => m.body === "back again")).toMatchObject({ nickname: a.nickname });
  await h.stop();
});

test("re-joins after its occupancy row went stale", async () => {
  // default 30 s tick: the send hits the stale row before any heartbeat could revive it
  const { a, h } = await joinedA("ra6");
  const stale = new Date(Date.now() - 120_000).toISOString();
  await check(adminClient().from("occupancy").update({ last_seen: stale }).eq("user_id", a.userId), "stale");
  // send_message on a stale row raises not_in_room; the helper re-joins and retries once
  expect(await h.call("/send", { body: "after sleep" })).toMatchObject({ ok: true });
  expect(await h.waitFor("joined", undefined, 5000)).toMatchObject({ room: testRoom });
  await h.waitFor("backlog");
  expect(await h.waitFor("message", (m) => m.body === "after sleep")).toMatchObject({ nickname: a.nickname });
  const rows = await occupancyOf(a.userId);
  expect(Date.parse(rows[0]!.last_seen)).toBeGreaterThan(Date.now() - 30_000);
  await h.stop();
});

test("kicked only acts for me", async () => {
  const { a, h } = await joinedA("ra7");
  const b = await agedUser("rb7");
  await memberB(b);
  const mod = await agedUser("rm7", "moderator");

  await check(mod.rpc("mod_ban", { target: b.userId, reason: "not you" }), "ban B");
  await Bun.sleep(1500);
  expect(h.events.some((e) => e.type === "kicked")).toBe(false);

  await check(mod.rpc("mod_ban", { target: a.userId, reason: "you, A" }), "ban A");
  expect(await h.waitFor("kicked", undefined, 5000)).toEqual({ type: "kicked", reason: "you, A" });
  expect(h.events.filter((e) => e.type === "kicked").length).toBe(1);
  // the room is dropped, the process stays up for the mod to stop it
  expect(await h.call("/status")).toMatchObject({ ok: true, data: { room: null } });
  expect(h.proc.exitCode).toBeNull();
  await h.stop();
});

test("room_closed is reported", async () => {
  const { a, h } = await joinedA("ra8", { COFFEEBREAK_TICK_MS: "1000" });
  try {
    await check(adminClient().from("rooms").update({ is_open: false }).eq("slug", testRoom), "close room");
    await h.waitFor("room_closed", undefined, 5000);
    expect(await h.call("/status")).toMatchObject({ ok: true, data: { room: null } });
    // room_closed is emitted first, then leave_room runs
    let rows = await occupancyOf(a.userId);
    for (let i = 0; i < 40 && rows.length; i++) {
      await Bun.sleep(50);
      rows = await occupancyOf(a.userId);
    }
    expect(rows).toEqual([]);
  } finally {
    await check(adminClient().from("rooms").update({ is_open: true }).eq("slug", testRoom), "reopen room");
  }
  await h.stop();
});

test("a re-join refused because the room closed is reported as room_closed", async () => {
  const { a, h } = await joinedA("ra13", { COFFEEBREAK_TICK_MS: "1000" });
  try {
    // purged row: heartbeat says not_in_room, then join_room says room_closed
    await check(adminClient().from("occupancy").delete().eq("user_id", a.userId), "purge occupancy");
    await check(adminClient().from("rooms").update({ is_open: false }).eq("slug", testRoom), "close room");
    await h.waitFor("room_closed", undefined, 5000);
    expect(await h.call("/status")).toMatchObject({ ok: true, data: { room: null } });
    await Bun.sleep(2500); // two more ticks: no repeated events
    expect(h.events.filter((e) => e.type === "room_closed")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "error")).toEqual([]);
  } finally {
    await check(adminClient().from("rooms").update({ is_open: true }).eq("slug", testRoom), "reopen room");
  }
  await h.stop();
});

test("send maps errors", async () => {
  const { h } = await joinedA("ra9");
  expect(await h.call("/send", { body: "first" })).toMatchObject({ ok: true });
  expect(await h.call("/send", { body: "second" })).toMatchObject({ ok: false, code: "rate_limited" });
  expect(await h.call("/send", { body: "x".repeat(281) })).toMatchObject({ ok: false, code: "too_long" });
  await h.stop();
});

test("report resolves the target and message", async () => {
  const { h } = await joinedA("ra10");
  const b = await agedUser("rb10");
  await memberB(b);
  const msg = await send(b, "spammy");
  const res = await h.call("/report", { nickname: b.nickname, message_id: msg.id, reason: "spam" });
  expect(res).toMatchObject({ ok: true });
  expect((res as { data: { report_id: number } }).data.report_id).toBeGreaterThan(0);
  await h.stop();
});

test("moderator commands resolve nicknames", async () => {
  const b = await agedUser("rb11");
  const mod = await agedUser("rm11", "moderator");
  const h = await helperFor(mod);
  // public_profiles.nickname is citext: the lookup is case-insensitive
  expect(await h.call("/mod/mute", { nickname: b.nickname.toUpperCase(), minutes: 10, reason: "x" })).toEqual({
    ok: true,
    data: {},
  });
  const { data } = await check(adminClient().from("profiles").select("muted_until").eq("id", b.userId), "profile");
  expect(Date.parse((data as { muted_until: string }[])[0]!.muted_until)).toBeGreaterThan(Date.now());
  expect(await h.call("/mod/mute", { nickname: "nobody_" + b.nickname, minutes: 10, reason: "x" })).toMatchObject({
    ok: false,
    code: "not_found",
  });
  expect(await h.call("/mod/ban", { nickname: "nobody_" + b.nickname, reason: "x" })).toMatchObject({
    ok: false,
    code: "not_found",
  });
  await h.stop();
});

test("leave removes occupancy", async () => {
  const { a, h } = await joinedA("ra12");
  expect(await occupancyOf(a.userId)).toHaveLength(1);
  expect(await h.call("/leave")).toEqual({ ok: true, data: {} });
  expect(await occupancyOf(a.userId)).toEqual([]);
  expect(await h.call("/status")).toMatchObject({ ok: true, data: { room: null } });
  await h.stop();
});

test("a second helper of the same account survives the first one leaving", async () => {
  const a = await agedUser("rsid1");
  const c = await agedUser("rsid2");
  const hA = await helperFor(a);
  const hB = await helperFor(a, { COFFEEBREAK_TICK_MS: "1000" });
  const hC = await helperFor(c);
  const jA = await hA.call("/join", { room: testRoom });
  const jB = await hB.call("/join", { room: testRoom });
  const jC = await hC.call("/join", { room: testRoom });
  expect(jA).toMatchObject({ ok: true, data: { topic: topic1 } });
  expect(jB).toMatchObject({ ok: true, data: { topic: topic1 } });
  expect(jC).toMatchObject({ ok: true });
  await hB.waitFor("joined");
  await hB.waitFor("backlog");
  await hC.waitFor("joined");
  await hC.waitFor("backlog");
  await Bun.sleep(1500); // let presence settle (events may precede the backlog)
  const joinedBefore = hB.events.filter((e) => e.type === "joined").length;
  const { data: prof } = await check(adminClient().from("profiles").select("nickname").eq("id", a.userId).single(), "nick");
  const nickname = (prof as { nickname: string }).nickname;

  expect(await hA.call("/leave")).toEqual({ ok: true, data: {} });
  expect(await occupancyOf(a.userId)).toHaveLength(1);
  await Bun.sleep(3000);
  expect(hB.events.filter((e) => e.type === "joined")).toHaveLength(joinedBefore);
  expect(await hB.call("/send", { body: "still here" })).toMatchObject({ ok: true });
  const leftA = hC.events.filter((e) => e.type === "presence" && e.left.includes(nickname));
  expect(leftA).toEqual([]);

  expect(await hB.call("/leave")).toEqual({ ok: true, data: {} });
  expect(await occupancyOf(a.userId)).toEqual([]);
  await hA.stop();
  await hB.stop();
  await hC.stop();
});
