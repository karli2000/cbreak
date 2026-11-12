import { expect, test } from "bun:test";
import { codeOf } from "../../plugin/helper/rpc";

test("codeOf takes the backend error code", () => {
  expect(codeOf({ message: "rate_limited", code: "P0001" })).toBe("rate_limited");
});
test("codeOf maps fetch failures to network", () => {
  expect(codeOf(new TypeError("fetch failed"))).toBe("network");
});
test("codeOf maps anything else to unknown", () => {
  expect(codeOf({ message: "duplicate key value violates unique constraint" })).toBe("unknown");
});
test("codeOf maps postgrest-js transport failures (returned, not thrown) to network", () => {
  // the exact shape postgrest-js 2.x returns when fetch rejects (Bun 1.4, DNS failure)
  const dns = {
    message: "TypeError: getaddrinfo ENOTFOUND meioekkvutvrspfvqgye.supabase.co",
    details: "TypeError: getaddrinfo ENOTFOUND meioekkvutvrspfvqgye.supabase.co\n    at async fetchWithRetry (…)",
    hint: "",
    code: "",
  };
  expect(codeOf(dns)).toBe("network");
  for (const message of [
    "TypeError: fetch failed",
    "FetchError: request to https://x failed",
    "AbortError: The user aborted a request.",
    "TypeError: Unable to connect. Is the computer able to access the url?",
    "Error: getaddrinfo EAI_AGAIN host",
    "Error: connect ETIMEDOUT 1.2.3.4:443",
    "Error: connect ENETUNREACH 1.2.3.4:443",
    "Error: read ECONNRESET",
    "Error: connect EHOSTUNREACH 1.2.3.4:443",
  ]) {
    expect([message, codeOf({ message, code: "" })]).toEqual([message, "network"]);
  }
  // a database error with a SQLSTATE stays unknown even if its text mentions a type error
  expect(codeOf({ message: "TypeError: no", code: "42883" })).toBe("unknown");
});
test("codeOf treats errno codes (not SQLSTATEs) as transport failures", () => {
  expect(codeOf({ message: "connect ECONNREFUSED 127.0.0.1:54321", code: "ECONNREFUSED" })).toBe("network");
  expect(codeOf({ message: "write EPIPE", code: "EPIPE" })).toBe("network");
  expect(codeOf({ message: "FetchError: x", code: "PGRST301" })).toBe("unknown");
});
