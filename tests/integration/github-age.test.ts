// github-age Edge Function: fills profiles.github_created_at from the public GitHub API.
// Needs `bunx supabase functions serve` running. The octocat test calls the real GitHub API
// (60 requests/hour unauthenticated).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { adminClient, cleanup, env, userClient, type TestUser } from "./_env";

setDefaultTimeout(30_000);

afterAll(cleanup);

async function call(user: TestUser | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (user) {
    const { data } = await user.auth.getSession();
    headers.Authorization = `Bearer ${data.session!.access_token}`;
  } else {
    headers.Authorization = `Bearer ${env().anonKey}`;
  }
  const res = await fetch(`${env().url}/functions/v1/github-age`, { method: "POST", headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function setProfile(user: TestUser, patch: Record<string, unknown>) {
  const { error } = await adminClient().from("profiles").update(patch).eq("id", user.userId);
  if (error) throw new Error(JSON.stringify(error));
}

async function storedCreatedAt(user: TestUser): Promise<string | null> {
  const { data, error } = await adminClient()
    .from("profiles")
    .select("github_created_at")
    .eq("id", user.userId)
    .single();
  if (error) throw new Error(JSON.stringify(error));
  return data.github_created_at;
}

describe("github-age", () => {
  test("rejects a call without a user JWT", async () => {
    const r = await call(null);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "unauthorized" });
  });

  test("fills github_created_at from GitHub (octocat)", async () => {
    const u = await userClient("gh_octo");
    await setProfile(u, { github_id: 583231, github_created_at: null });
    const r = await call(u);
    expect(r.status).toBe(200);
    expect(new Date(r.body.github_created_at as string).toISOString()).toBe("2011-01-25T18:44:36.000Z");
    expect(new Date((await storedCreatedAt(u))!).toISOString()).toBe("2011-01-25T18:44:36.000Z");
  });

  test("returns an already-set value without calling GitHub or changing it", async () => {
    const u = await userClient("gh_set");
    // github_id of a user that does not exist on GitHub: a GitHub call would fail
    await setProfile(u, { github_id: 999999999999, github_created_at: "2020-05-05T05:05:05Z" });
    const r = await call(u);
    expect(r.status).toBe(200);
    expect(new Date(r.body.github_created_at as string).toISOString()).toBe("2020-05-05T05:05:05.000Z");
    expect(new Date((await storedCreatedAt(u))!).toISOString()).toBe("2020-05-05T05:05:05.000Z");
  });

  test("400 no_github_id when the profile has no github_id", async () => {
    const u = await userClient("gh_none");
    await setProfile(u, { github_id: null, github_created_at: null });
    const r = await call(u);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "no_github_id" });
    expect(await storedCreatedAt(u)).toBeNull();
  });
});
