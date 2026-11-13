// Shared setup for integration tests against a running Supabase stack.
// Local: URL/keys come from `bunx supabase status -o json`.
// Hosted (Task 11): set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and
// INTEGRATION_ALLOW_REMOTE=1 (any non-local URL is refused without it).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Env = { url: string; anonKey: string; serviceKey: string; dbUrl?: string };

let cached: Env | undefined;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function env(): Env {
  if (cached) return cached;
  let e: Env;
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY) {
    e = { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, serviceKey: SUPABASE_SERVICE_ROLE_KEY, dbUrl: process.env.SUPABASE_DB_URL };
  } else {
    const out = Bun.spawnSync(["bunx", "supabase", "status", "-o", "json"], { stderr: "pipe" });
    if (out.exitCode !== 0) {
      throw new Error(`supabase status failed (is the stack running?): ${out.stderr.toString()}`);
    }
    const s = JSON.parse(out.stdout.toString());
    const anonKey = s.ANON_KEY ?? s.PUBLISHABLE_KEY;
    const serviceKey = s.SERVICE_ROLE_KEY ?? s.SECRET_KEY;
    if (!s.API_URL || !anonKey || !serviceKey) throw new Error("supabase status: missing API_URL or keys");
    e = { url: s.API_URL, anonKey, serviceKey, dbUrl: s.DB_URL };
  }
  if (!LOCAL_HOSTS.has(new URL(e.url).hostname) && process.env.INTEGRATION_ALLOW_REMOTE !== "1") {
    throw new Error(`refusing to run integration tests against ${e.url}: set INTEGRATION_ALLOW_REMOTE=1`);
  }
  console.log(`integration target: ${e.url}`);
  cached = e;
  return cached;
}

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 20 } },
};

let admin: SupabaseClient | undefined;

export function adminClient(): SupabaseClient {
  admin ??= createClient(env().url, env().serviceKey, clientOptions);
  return admin;
}

/** Random 4-char suffix so repeated runs don't collide on nicknames or rooms. */
export const runId = Math.random().toString(36).slice(2, 6);

/** Per-run rooms; tests never touch real rooms such as `lobby`. */
export const testRoom = `itest-${runId}`;
export const otherRoom = `itest-${runId}-b`;
const testRooms = [testRoom, otherRoom];

export type TestUser = SupabaseClient & { userId: string; nickname: string };

/** Every user created and not yet deleted (module-level so failed hooks still get cleaned up). */
const created: TestUser[] = [];

function check<T extends { error: unknown }>(res: T, what: string): T {
  if (res.error) throw new Error(`${what}: ${JSON.stringify(res.error)}`);
  return res;
}

/** Whether tests can reach Postgres directly (local stack, or SUPABASE_DB_URL on a hosted run). */
export function hasDb(): boolean {
  return !!env().dbUrl;
}

/**
 * Gives an auth user a GitHub identity (provider_id = `ghId`) straight in the database, as the
 * GitHub sign-in would. A first claim_nickname needs one (migration 20261117000100). Needs `hasDb()`.
 */
export async function githubIdentity(userId: string, ghId: number): Promise<void> {
  const dbUrl = env().dbUrl;
  if (!dbUrl) throw new Error("githubIdentity needs a database URL (local stack or SUPABASE_DB_URL)");
  const { SQL } = await import("bun");
  const sql = new SQL(dbUrl);
  try {
    await sql`insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
      values (gen_random_uuid(), ${String(ghId)}, ${userId}::uuid, jsonb_build_object('sub', ${String(ghId)}::text), 'github', now(), now())`;
  } finally {
    await sql.close();
  }
}

let nextGithubId = 900_000_000 + Math.floor(Math.random() * 90_000_000);

/**
 * Creates an email/password user via the admin API, signs in, and gives it a ready profile
 * `<nick>_<runId>` (rules accepted, a made-up GitHub id) through the service role, since a
 * first claim_nickname needs a GitHub identity. The role is set the same way.
 */
export async function userClient(
  nick: string,
  role: "user" | "moderator" | "admin" = "user",
): Promise<TestUser> {
  const nickname = `${nick}_${runId}`;
  const email = `${nickname}@test.local`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data: made } = check(
    await adminClient().auth.admin.createUser({ email, password, email_confirm: true }),
    `create user ${nickname}`,
  );

  const client = createClient(env().url, env().anonKey, clientOptions) as TestUser;
  client.userId = made.user!.id;
  client.nickname = nickname;
  created.push(client);

  check(await client.auth.signInWithPassword({ email, password }), "sign in");
  await client.realtime.setAuth();
  check(
    await adminClient()
      .from("profiles")
      .insert({ id: client.userId, nickname, github_id: nextGithubId++, rules_accepted_at: new Date().toISOString(), role }),
    `create profile ${nickname}`,
  );
  return client;
}

/**
 * Email user signed in without a profile (no claim_nickname), tracked for cleanup.
 * Its `nickname` is unset until claimed. With `github`, the user gets a GitHub identity (needs
 * `hasDb()`), so it can claim a first nickname.
 */
export async function bareUser(github = false): Promise<TestUser> {
  const email = `bare_${runId}_${crypto.randomUUID().slice(0, 8)}@test.local`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data: made } = check(
    await adminClient().auth.admin.createUser({ email, password, email_confirm: true }),
    "create bare user",
  );
  const client = createClient(env().url, env().anonKey, clientOptions) as TestUser;
  client.userId = made.user!.id;
  client.nickname = "";
  created.push(client);
  if (github) await githubIdentity(client.userId, nextGithubId++);
  check(await client.auth.signInWithPassword({ email, password }), "sign in");
  return client;
}

/** Removes all channels and deletes every user created since the last cleanup. */
export async function cleanup(): Promise<void> {
  const users = created.splice(0);
  await Promise.all(users.map((u) => u.removeAllChannels()));
  const results = await Promise.all(users.map((u) => adminClient().auth.admin.deleteUser(u.userId)));
  const failed = results.filter((r) => r.error);
  if (failed.length) throw new Error(`delete users: ${failed.map((r) => r.error!.message).join(", ")}`);
}

/** Creates the per-run rooms via the service role. */
export async function createTestRooms(): Promise<void> {
  check(
    await adminClient()
      .from("rooms")
      .insert(testRooms.map((slug) => ({ slug, title: `integration ${slug}` }))),
    "create test rooms",
  );
}

/** Deletes all remaining test users, then the per-run rooms and their messages. Idempotent. */
export async function teardown(): Promise<void> {
  try {
    await cleanup();
  } finally {
    const a = adminClient();
    check(await a.from("occupancy").delete().in("room", testRooms), "delete test occupancy");
    check(await a.from("messages").delete().in("room", testRooms), "delete test messages");
    check(await a.from("rooms").delete().in("slug", testRooms), "delete test rooms");
  }
}

/**
 * Realtime starts streaming DB broadcasts (realtime.send) only after its tenant has connected
 * and created the replication slot, which happens lazily on the first client connection
 * (e.g. right after `db reset`). A broadcast sent before that is lost. This sends messages in the
 * test room until one arrives, then deletes the warm-up user. Subscribing is retried while the
 * Realtime container restarts after `db reset`.
 */
export async function warmUpRealtime(timeoutMs = 30_000): Promise<void> {
  try {
    const user = await userClient("warmup");
    // an old GitHub account gets the 2 s rate limit instead of 10 s
    check(
      await adminClient()
        .from("profiles")
        .update({ github_created_at: "2020-01-01T00:00:00Z" })
        .eq("id", user.userId),
      "age warm-up user",
    );
    const { data } = check(await user.rpc("join_room", { room_slug: testRoom }), "warm-up join_room");

    const topic = (data as { topic: string }).topic;
    const deadline = Date.now() + timeoutMs;

    // right after `db reset` the Realtime container is still restarting and a join fails
    // with "transport failure"; retry until it is up
    let received = false;
    let status = "";
    while (Date.now() < deadline) {
      const channel = user
        .channel(topic, { config: { private: true } })
        .on("broadcast", { event: "message" }, () => (received = true));
      status = await new Promise<string>((resolve) =>
        channel.subscribe((s, err) => resolve(err ? `${s} (${err.message})` : s)),
      );
      if (status === "SUBSCRIBED") break;
      await user.removeChannel(channel);
      await Bun.sleep(500);
    }
    if (status !== "SUBSCRIBED") throw new Error(`warm-up subscribe failed: ${status}`);

    for (let i = 0; !received && Date.now() < deadline; i++) {
      check(await user.rpc("send_message", { body: `warm-up ${i}` }), "warm-up send_message");
      for (let t = 0; t < 25 && !received; t++) await Bun.sleep(100);
    }
    if (!received) throw new Error("realtime did not deliver a DB broadcast during warm-up");
  } finally {
    await cleanup();
  }
}

/** beforeAll body: rooms + warm-up; on any failure everything created so far is removed. */
export async function setup(): Promise<void> {
  try {
    await createTestRooms();
    await warmUpRealtime();
  } catch (err) {
    await teardown().catch((e) => console.error("teardown after failed setup:", e));
    throw err;
  }
}
