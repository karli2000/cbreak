import { expect, test } from "bun:test";
import { createEmitter } from "../../plugin/helper/emit";

test("writes one JSON line", () => {
  const out: string[] = [];
  createEmitter((s) => void out.push(s), () => {})({ type: "deleted", id: 7 });
  expect(out).toEqual(['{"type":"deleted","id":7}\n']);
});

test("EPIPE calls onBrokenPipe once and does not throw", () => {
  let calls = 0;
  const emit = createEmitter(() => { throw { code: "EPIPE" }; }, () => calls++);
  expect(() => emit({ type: "room_closed" })).not.toThrow();
  emit({ type: "room_closed" });
  expect(calls).toBe(1);
});

test("ERR_STREAM_DESTROYED counts as a broken pipe", () => {
  let calls = 0;
  const emit = createEmitter(() => { throw { code: "ERR_STREAM_DESTROYED" }; }, () => calls++);
  expect(() => emit({ type: "room_closed" })).not.toThrow();
  expect(calls).toBe(1);
});

test("other write errors are rethrown", () => {
  const emit = createEmitter(() => { throw new Error("boom"); }, () => {});
  expect(() => emit({ type: "room_closed" })).toThrow("boom");
});
