// Spike S3 (throwaway): GitHub login via Supabase Auth PKCE with a localhost callback,
// the way coffeebreakd will do it. Then claim a nickname, accept the rules and call
// github-age, so the whole first-run path is exercised once against the hosted project.
//
// Usage: SUPABASE_URL=… SUPABASE_ANON_KEY=… bun spikes/login/login.ts [nickname]
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const url = process.env.SUPABASE_URL!;
const anon = process.env.SUPABASE_ANON_KEY!;
if (!url || !anon) throw new Error("set SUPABASE_URL and SUPABASE_ANON_KEY");

const store = new Map<string, string>();
const supabase = createClient(url, anon, {
  auth: {
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: false,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  },
});

function openBrowser(target: string) {
  const isWsl = existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  const [cmd, args] = isWsl
    ? ["powershell.exe", ["-NoProfile", "-Command", `Start-Process '${target.replace(/'/g, "''")}'`]]
    : process.platform === "darwin"
      ? ["open", [target]]
      : ["xdg-open", [target]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
}

let resolveCode!: (code: string) => void;
const codePromise = new Promise<string>((r) => (resolveCode = r));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error_description") ?? u.searchParams.get("error");
    if (code) resolveCode(code);
    return new Response(
      code
        ? "<h2>☕ Signed in to Coffee Break. You can close this tab.</h2>"
        : `<h2>Login failed: ${err ?? "no code"}</h2>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

const redirectTo = `http://127.0.0.1:${server.port}/callback`;
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: "github",
  options: { redirectTo, skipBrowserRedirect: true },
});
if (error || !data.url) throw error ?? new Error("no oauth url");
console.log(`redirectTo: ${redirectTo}`);
console.log(`If the browser doesn't open, visit:\n${data.url}\n`);
openBrowser(data.url);

const timeout = setTimeout(() => {
  console.error("timed out after 5 min waiting for the GitHub callback");
  process.exit(2);
}, 5 * 60_000);
const code = await codePromise;
clearTimeout(timeout);

const { data: sess, error: exErr } = await supabase.auth.exchangeCodeForSession(code);
if (exErr) throw exErr;
server.stop();
const user = sess.user!;
const gh = user.identities?.find((i) => i.provider === "github");
console.log("user.id:", user.id);
console.log("github provider_id:", gh?.identity_data?.provider_id ?? gh?.id);
console.log("github user_name:", gh?.identity_data?.user_name);
console.log("identity_data keys:", Object.keys(gh?.identity_data ?? {}).join(", "));
console.log("access token expires in (s):", sess.session?.expires_in);
console.log("refresh token present:", Boolean(sess.session?.refresh_token));

const wanted = (process.argv[2] ?? String(gh?.identity_data?.user_name ?? "")).toLowerCase();
const { data: prof, error: claimErr } = await supabase.rpc("claim_nickname", { nick: wanted });
console.log("claim_nickname:", claimErr ? `ERROR ${claimErr.message}` : prof?.nickname);
const { error: rulesErr } = await supabase.rpc("accept_rules");
console.log("accept_rules:", rulesErr ? `ERROR ${rulesErr.message}` : "ok");
const age = await supabase.functions.invoke("github-age", { method: "POST" });
console.log("github-age:", age.error ? `ERROR ${age.error.message}` : JSON.stringify(age.data));
process.exit(0);
