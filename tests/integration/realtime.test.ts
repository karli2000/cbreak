// Realtime authorization: private room channels, DB-only chat broadcasts, presence-only client writes.
// All tests use the per-run rooms from _env.ts, never real rooms.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  adminClient,
  cleanup,
  otherRoom,
  setup,
  teardown,
  testRoom,
  userClient,
  type TestUser,
} from "./_env";

type Received = { event: string; payload: Record<string, unknown> };

const topic1 = `room:${testRoom}:1`;

/** Opens the private channel for `topic`, records every broadcast, resolves with the final status. */
function subscribe(user: TestUser, topic: string) {
  const received: Received[] = [];
  const channel: RealtimeChannel = user
    .channel(topic, { config: { private: true, presence: { key: user.userId } } })
    .on("broadcast", { event: "*" }, (msg) => received.push({ event: msg.event, payload: msg.payload }))
    .on("presence", { event: "sync" }, () => {}); // a presence listener enables presence on join
  // first status wins: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT or CLOSED
  const status = new Promise<string>((resolve) => channel.subscribe((s) => resolve(s)));
  return { channel, received, status };
}

async function waitFor<T>(check: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = check();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  return check();
}

async function join(user: TestUser, room = testRoom): Promise<string> {
  const { data, error } = await user.rpc("join_room", { room_slug: room });
  if (error) throw error;
  return (data as { topic: string }).topic;
}

async function serviceUpdate(table: string, values: Record<string, unknown>, userCol: string, id: string) {
  const { error } = await adminClient().from(table).update(values).eq(userCol, id);
  if (error) throw error;
}

// unauthorized joins take ~5 s to come back as CHANNEL_ERROR
setDefaultTimeout(20_000);

// creates the per-run rooms; after `db reset` the first DB broadcast can be lost while
// Realtime starts replicating, so this also warms Realtime up
beforeAll(() => setup(), 50_000);

afterEach(() => cleanup());

afterAll(() => teardown());

describe("realtime authorization", () => {
  test("room members receive messages sent via send_message", async () => {
    const alice = await userClient("alice");
    const bob = await userClient("bob");
    const topic = await join(alice);
    expect(await join(bob)).toBe(topic);

    const a = subscribe(alice, topic);
    const b = subscribe(bob, topic);
    expect(await a.status).toBe("SUBSCRIBED");
    expect(await b.status).toBe("SUBSCRIBED");

    const { error } = await alice.rpc("send_message", { body: "hello" });
    expect(error).toBeNull();

    const msg = await waitFor(() => b.received.find((r) => r.event === "message"), 3000);
    expect(msg).toBeDefined();
    expect(msg!.payload.nickname).toBe(alice.nickname);
    expect(msg!.payload.body).toBe("hello");
  });

  test("a client cannot broadcast chat itself", async () => {
    const alice = await userClient("alice");
    const bob = await userClient("bob");
    const topic = await join(alice);
    expect(await join(bob)).toBe(topic);

    const a = subscribe(alice, topic);
    const b = subscribe(bob, topic);
    expect(await a.status).toBe("SUBSCRIBED");
    expect(await b.status).toBe("SUBSCRIBED");

    await a.channel.send({
      type: "broadcast",
      event: "message",
      payload: { nickname: bob.nickname, body: "fake" },
    });
    await Bun.sleep(2000);
    expect(b.received).toEqual([]);
  });

  test("presence: both members are tracked", async () => {
    const alice = await userClient("alice");
    const bob = await userClient("bob");
    const topic = await join(alice);
    expect(await join(bob)).toBe(topic);

    const a = subscribe(alice, topic);
    const b = subscribe(bob, topic);
    expect(await a.status).toBe("SUBSCRIBED");
    expect(await b.status).toBe("SUBSCRIBED");

    expect(await a.channel.track({})).toBe("ok");
    expect(await b.channel.track({})).toBe("ok");

    const keys = await waitFor(() => {
      const k = Object.keys(a.channel.presenceState()).sort();
      return k.length === 2 ? k : undefined;
    }, 3000);
    expect(keys).toEqual([alice.userId, bob.userId].sort());
  });

  test("a user who has not joined the room cannot subscribe", async () => {
    const carol = await userClient("carol");
    const c = subscribe(carol, topic1);
    expect(await c.status).toBe("CHANNEL_ERROR");
  });

  test("a banned user is kicked and cannot re-subscribe", async () => {
    const mod = await userClient("mod", "moderator");
    const bob = await userClient("bob");
    const topic = await join(bob);

    const b = subscribe(bob, topic);
    expect(await b.status).toBe("SUBSCRIBED");

    const { error } = await mod.rpc("mod_ban", { target: bob.userId, reason: "test" });
    expect(error).toBeNull();

    const kicked = await waitFor(() => b.received.find((r) => r.event === "kicked"), 3000);
    expect(kicked).toBeDefined();
    expect(kicked!.payload.user_id).toBe(bob.userId);

    await bob.removeChannel(b.channel);
    const again = subscribe(bob, topic);
    expect(await again.status).toBe("CHANNEL_ERROR");
  });

  test("parallel sends: exactly one passes the rate limit", async () => {
    const alice = await userClient("alice");
    const topic = await join(alice);
    const a = subscribe(alice, topic); // ensures today's realtime.messages partition exists
    expect(await a.status).toBe("SUBSCRIBED");

    const results = await Promise.all(
      ["one", "two", "three"].map((body) => alice.rpc("send_message", { body })),
    );
    const ok = results.filter((r) => r.error === null);
    const limited = results.filter((r) => r.error?.message === "rate_limited");
    expect(ok.length).toBe(1);
    expect(limited.length).toBe(2);
  });
});

describe("realtime policy branches", () => {
  test("a banned user with an occupancy row cannot subscribe", async () => {
    const eve = await userClient("eve");
    expect(await join(eve)).toBe(topic1);
    await serviceUpdate("profiles", { banned_at: new Date().toISOString() }, "id", eve.userId);

    const e = subscribe(eve, topic1);
    expect(await e.status).toBe("CHANNEL_ERROR");
  });

  test("a moderator without occupancy can subscribe to any room topic", async () => {
    const mod = await userClient("mod", "moderator");
    const m = subscribe(mod, topic1);
    expect(await m.status).toBe("SUBSCRIBED");
  });

  test("members of another room or instance cannot subscribe", async () => {
    const dave = await userClient("dave");
    const frank = await userClient("frank");
    expect(await join(dave, otherRoom)).toBe(`room:${otherRoom}:1`);
    // frank sits in instance 2 of the test room
    const { error } = await adminClient()
      .from("occupancy")
      .insert({ user_id: frank.userId, room: testRoom, instance: 2 });
    expect(error).toBeNull();

    const d = subscribe(dave, topic1);
    const f = subscribe(frank, topic1);
    expect(await d.status).toBe("CHANNEL_ERROR");
    expect(await f.status).toBe("CHANNEL_ERROR");
  });

  test("a user with a stale occupancy row cannot subscribe", async () => {
    const gina = await userClient("gina");
    expect(await join(gina)).toBe(topic1);
    const stale = new Date(Date.now() - 120_000).toISOString();
    await serviceUpdate("occupancy", { last_seen: stale }, "user_id", gina.userId);

    const g = subscribe(gina, topic1);
    expect(await g.status).toBe("CHANNEL_ERROR");
  });
});
