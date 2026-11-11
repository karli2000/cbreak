// Shared setup for integration tests against a running Supabase stack.
// Local: URL/keys come from `bunx supabase status -o json`.
// Hosted (Task 11): set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Env = { url: string; anonKey: string; serviceKey: string };

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY) {
    cached = { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, serviceKey: SUPABASE_SERVICE_ROLE_KEY };
    return cached;
  }
  const out = Bun.spawnSync(["bunx", "supabase", "status", "-o", "json"], { stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`supabase status failed (is the stack running?): ${out.stderr.toString()}`);
  }
  const s = JSON.parse(out.stdout.toString());
  const anonKey = s.ANON_KEY ?? s.PUBLISHABLE_KEY;
  const serviceKey = s.SERVICE_ROLE_KEY ?? s.SECRET_KEY;
  if (!s.API_URL || !anonKey || !serviceKey) throw new Error("supabase status: missing API_URL or keys");
  cached = { url: s.API_URL, anonKey, serviceKey };
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

/** Random 4-char suffix so repeated runs don't collide on nicknames. */
export const runId = Math.random().toString(36).slice(2, 6);

export type TestUser = SupabaseClient & { userId: string; nickname: string };

const created: TestUser[] = [];

/**
 * Creates an email/password user via the admin API, signs in, claims `<nick>_<runId>`,
 * accepts the rules and sets the role via the service role.
 */
export async function userClient(
  nick: string,
  role: "user" | "moderator" | "admin" = "user",
): Promise<TestUser> {
  const nickname = `${nick}_${runId}`;
  const email = `${nickname}@test.local`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data: made, error: createErr } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw createErr;

  const client = createClient(env().url, env().anonKey, clientOptions) as TestUser;
  client.userId = made.user.id;
  client.nickname = nickname;
  created.push(client);

  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  await client.realtime.setAuth();

  const claim = await client.rpc("claim_nickname", { nick: nickname });
  if (claim.error) throw claim.error;
  const rules = await client.rpc("accept_rules");
  if (rules.error) throw rules.error;

  if (role !== "user") {
    const { error } = await adminClient().from("profiles").update({ role }).eq("id", client.userId);
    if (error) throw error;
  }
  return client;
}

/**
 * Realtime starts streaming DB broadcasts (realtime.send) only after its tenant has connected
 * and created the replication slot, which happens lazily on the first client connection
 * (e.g. right after `db reset`). A broadcast sent before that is lost. This sends messages in a
 * throw-away room until one arrives, then removes the room, its messages and the user.
 */
export async function warmUpRealtime(timeoutMs = 20_000): Promise<void> {
  const slug = `itest-${runId}`;
  const admin = adminClient();
  const room = await admin.from("rooms").insert({ slug, title: "integration warm-up" });
  if (room.error) throw room.error;
  const user = await userClient("warmup");
  try {
    // an old GitHub account gets the 2 s rate limit instead of 10 s
    const old = await admin
      .from("profiles")
      .update({ github_created_at: "2020-01-01T00:00:00Z" })
      .eq("id", user.userId);
    if (old.error) throw old.error;
    const { data, error } = await user.rpc("join_room", { room_slug: slug });
    if (error) throw error;

    let received = false;
    const channel = user
      .channel((data as { topic: string }).topic, { config: { private: true } })
      .on("broadcast", { event: "message" }, () => (received = true));
    const status = await new Promise<string>((resolve) => channel.subscribe((s) => resolve(s)));
    if (status !== "SUBSCRIBED") throw new Error(`warm-up subscribe failed: ${status}`);

    const deadline = Date.now() + timeoutMs;
    for (let i = 0; !received && Date.now() < deadline; i++) {
      const sent = await user.rpc("send_message", { body: `warm-up ${i}` });
      if (sent.error) throw sent.error;
      for (let t = 0; t < 25 && !received; t++) await Bun.sleep(100);
    }
    if (!received) throw new Error("realtime did not deliver a DB broadcast during warm-up");
  } finally {
    await cleanup();
    await admin.from("messages").delete().eq("room", slug);
    await admin.from("rooms").delete().eq("slug", slug);
  }
}

/** Removes all channels and deletes every user created since the last cleanup. */
export async function cleanup(): Promise<void> {
  const users = created.splice(0);
  await Promise.all(users.map((u) => u.removeAllChannels()));
  await Promise.all(users.map((u) => adminClient().auth.admin.deleteUser(u.userId)));
}
