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
  expect(u.searchParams.get("redirect_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
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
  const page = await fetch(`${redirect}?error=access_denied&error_description=${encodeURIComponent("<b>x</b>")}`);
  const html = await page.text();
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>");
  const err = await h.waitFor("error", (e) => e.code === "login_failed");
  expect(err.code).toBe("login_failed");
  // the callback server is stopped afterwards, and a new /login starts afresh
  const next = await h.call("/login");
  expect(next.ok && next.data.url).not.toBe(res.data.url);
});
