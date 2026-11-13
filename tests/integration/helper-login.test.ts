import { afterAll, expect, test } from "bun:test";
import { cleanupHelpers, startHelper } from "./_helper";

afterAll(cleanupHelpers);

test("login URL targets GitHub with a localhost callback", async () => {
  const h = await startHelper();
  const res = await h.call("/login");
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const u = new URL(res.data.url);
  expect(u.pathname).toBe("/auth/v1/authorize");
  expect(u.searchParams.get("provider")).toBe("github");
  expect(u.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
  // the callback carries a nonce only this login knows
  expect(u.searchParams.get("redirect_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?n=[0-9a-f]{32}$/);
  const ev = await h.waitFor("login");
  expect(ev.url).toBe(res.data.url);
  // a second /login while pending returns the same URL
  const again = await h.call("/login");
  expect(again.ok && again.data.url).toBe(res.data.url);
});

test("callback error is escaped and reported", async () => {
  const h = await startHelper();
  const res = await h.call("/login");
  if (!res.ok) throw new Error(JSON.stringify(res));
  const redirect = new URL(res.data.url).searchParams.get("redirect_to")!;
  const page = await fetch(`${redirect}&error=access_denied&error_description=${encodeURIComponent("<b>x</b>")}`);
  const html = await page.text();
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>");
  const err = await h.waitFor("error", (e) => e.code === "login_failed");
  expect(err.code).toBe("login_failed");
  // the callback server is stopped afterwards, and a new /login starts afresh
  const next = await h.call("/login");
  expect(next.ok && next.data.url).not.toBe(res.data.url);
});

test("concurrent /login calls share one flow", async () => {
  const h = await startHelper();
  const [a, b] = await Promise.all([h.call("/login"), h.call("/login")]);
  expect(a.ok && b.ok).toBe(true);
  if (a.ok && b.ok) expect(a.data.url).toBe(b.data.url);
  expect(h.events.filter((e) => e.type === "login").length).toBe(1);
});

test("a stray /callback request does not end a pending login", async () => {
  const h = await startHelper();
  const res = await h.call("/login");
  if (!res.ok) throw new Error(JSON.stringify(res));
  const redirect = new URL(res.data.url).searchParams.get("redirect_to")!;
  expect((await fetch(redirect)).status).toBe(400);
  expect((await fetch(`${redirect}&code=bogus`)).status).toBe(400);
  // without the nonce nothing is even looked at
  expect((await fetch(`${redirect.replace(/\?n=.*$/, "")}?error=access_denied`)).status).toBe(404);
  await Bun.sleep(300);
  expect(h.events.some((e) => e.type === "error")).toBe(false);
  const again = await h.call("/login");
  expect(again.ok && again.data.url).toBe(res.data.url);
});
