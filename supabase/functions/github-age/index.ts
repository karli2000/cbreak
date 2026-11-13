// POST /functions/v1/github-age
// Fills profiles.github_created_at for the caller from the public GitHub API, so clients
// cannot lie about their account age. Idempotent: an already-set value is returned as is.
// Every attempt is recorded in profiles.github_age_checked_at and a profile is looked up on
// GitHub at most once an hour, so a profile whose lookup keeps failing cannot burn the shared
// token's rate limit (429 try_later meanwhile).
import { createClient } from "jsr:@supabase/supabase-js@2";

const RETRY_AFTER_MS = 60 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);

  // resolve the caller from their own token
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("github_id, github_created_at")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) return json({ error: "internal" }, 500);
  if (!profile) return json({ error: "no_profile" }, 400);
  if (profile.github_created_at) return json({ github_created_at: profile.github_created_at });
  if (profile.github_id == null) return json({ error: "no_github_id" }, 400);
  const id = Number(profile.github_id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "no_github_id" }, 400);
  // claim the attempt atomically: only a row not checked within the hour is updated, so
  // concurrent calls cannot all reach GitHub (a failing lookup is not repeated for an hour)
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data: claimed, error: markError } = await admin
    .from("profiles")
    .update({ github_age_checked_at: new Date().toISOString() })
    .eq("id", userData.user.id)
    .is("github_created_at", null)
    .or(`github_age_checked_at.is.null,github_age_checked_at.lt.${cutoff}`)
    .select("id");
  if (markError) return json({ error: "internal" }, 500);
  if (!claimed?.length) return json({ error: "try_later" }, 429);

  const headers: Record<string, string> = {
    "User-Agent": "cbreak",
    Accept: "application/vnd.github+json",
  };
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/user/${id}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return json({ error: "github_unavailable" }, 502);
  }
  if (res.status === 404) return json({ error: "github_user_not_found" }, 400);
  if (res.status !== 200) return json({ error: "github_unavailable" }, 502);

  const createdAt = (await res.json())?.created_at;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return json({ error: "github_unavailable" }, 502);
  }

  const { error: updateError } = await admin
    .from("profiles")
    .update({ github_created_at: createdAt })
    .eq("id", userData.user.id);
  if (updateError) return json({ error: "internal" }, 500);
  return json({ github_created_at: createdAt });
});
