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
