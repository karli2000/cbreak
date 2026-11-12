import { describe, expect, test } from "bun:test";
import { inviteOnlyAction } from "./_env";

describe("invite_only guard", () => {
  test("remote with invite_only on throws the exact message", () => {
    expect(() => inviteOnlyAction("https://abc.supabase.co", true)).toThrow(
      "invite_only is on for the remote project; turn it off in the moderator site for the test run",
    );
  });
  test("remote with invite_only off is left alone", () => {
    expect(inviteOnlyAction("https://abc.supabase.co", false)).toBe("keep");
  });
  test("local with invite_only on is switched off", () => {
    expect(inviteOnlyAction("http://127.0.0.1:54321", true)).toBe("disable");
  });
  test("local with invite_only off is left alone", () => {
    expect(inviteOnlyAction("http://localhost:54321", false)).toBe("keep");
  });
});
