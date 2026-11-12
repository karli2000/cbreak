import { expect, test } from "bun:test";
import { IdleWatch } from "../../plugin/helper/idle";

const watch = (idleExitMs = 60_000, intervalMs = 1000) => {
  let t = 1_000_000;
  const w = new IdleWatch({ idleExitMs, intervalMs, now: () => t });
  return { w, at: (ms: number) => (t += ms) };
};

test("idle after idleExitMs of regular checks without a request", () => {
  const { w, at } = watch();
  for (let i = 0; i < 59; i++) { at(1000); expect(w.check()).toBe(false); }
  at(1000);
  expect(w.check()).toBe(true);
});

test("a request resets the idle time", () => {
  const { w, at } = watch();
  for (let i = 0; i < 50; i++) { at(1000); w.check(); }
  w.touch();
  for (let i = 0; i < 59; i++) { at(1000); expect(w.check()).toBe(false); }
});

test("a suspend (a gap far longer than the check interval) counts as activity, not idle time", () => {
  const { w, at } = watch();
  at(1000); w.check();
  at(10 * 60_000); // laptop slept 10 minutes
  expect(w.check()).toBe(false);
  // the mod's overdue ping gets a full idle period to arrive
  for (let i = 0; i < 59; i++) { at(1000); expect(w.check()).toBe(false); }
  at(1000);
  expect(w.check()).toBe(true);
});

test("a gap of up to 3 intervals is a normal late timer", () => {
  const { w, at } = watch(5000, 1000);
  at(3000); expect(w.check()).toBe(false);
  at(2000); expect(w.check()).toBe(true);
});
