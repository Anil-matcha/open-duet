import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime } from "./relative-time.ts";

const now = new Date(2026, 9, 31, 12, 0, 0).getTime();
const ago = (ms) => new Date(now - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const at = (y, m, d, h) => new Date(y, m, d, h).toISOString();

test("under 45 seconds, and a clock slightly ahead, read as just now", () => {
  assert.deepEqual(relativeTime(ago(10_000), now), { key: "time.now" });
  assert.deepEqual(relativeTime(ago(-5_000), now), { key: "time.now" });
});

test("minutes and hours count up within the day", () => {
  assert.deepEqual(relativeTime(ago(5 * MIN), now), { key: "time.minutes", n: 5 });
  assert.deepEqual(relativeTime(ago(59 * MIN), now), { key: "time.minutes", n: 59 });
  assert.deepEqual(relativeTime(ago(3 * HOUR), now), { key: "time.hours", n: 3 });
});

test("the previous calendar day is yesterday, even under 24 hours ago", () => {
  assert.deepEqual(relativeTime(at(2026, 9, 30, 23), now), { key: "time.yesterday" });
  assert.deepEqual(relativeTime(at(2026, 9, 30, 8), now), { key: "time.yesterday" });
});

test("two to seven days show a day count", () => {
  assert.deepEqual(relativeTime(at(2026, 9, 29, 9), now), { key: "time.days", n: 2 });
  assert.deepEqual(relativeTime(at(2026, 9, 24, 9), now), { key: "time.days", n: 7 });
});

test("after a week it is a plain date, with the year only when it differs", () => {
  const same = relativeTime(at(2026, 9, 20, 9), now);
  assert.ok("date" in same && same.date.length > 0 && !same.date.includes("2026"));
  const other = relativeTime(at(2025, 9, 20, 9), now);
  assert.ok("date" in other && other.date.includes("2025"));
});

test("an unreadable timestamp gives null", () => {
  assert.equal(relativeTime("nope", now), null);
});
