import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDateDivider, formatMessageTime, relativeTime } from "./relative-time.ts";

const now = new Date(2026, 9, 31, 12, 0, 0).getTime();
const ago = (ms) => new Date(now - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min).toISOString();

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

test("formatMessageTime formats same day as time only", () => {
  const result = formatMessageTime(at(2026, 9, 31, 11, 7), null, now);
  assert.ok(result && (result.includes("11:07") || result.includes("11.07")));
  assert.ok(!result.toLowerCase().includes("yesterday"));
});

test("formatMessageTime formats previous day with Yesterday", () => {
  const result = formatMessageTime(at(2026, 9, 30, 17, 26), (k) => k === "time.yesterday" ? "yesterday" : k, now);
  assert.ok(result && result.startsWith("Yesterday, "));
  assert.ok(result.includes("5:26") || result.includes("17:26"));
});

test("formatMessageTime formats earlier dates with month and day", () => {
  const result = formatMessageTime(at(2026, 9, 25, 14, 30), null, now);
  assert.ok(result && !result.includes("2026"));
  assert.ok(result.includes("25") || result.includes("Oct"));
});

test("formatMessageTime formats previous year with year", () => {
  const result = formatMessageTime(at(2025, 9, 25, 14, 30), null, now);
  assert.ok(result && result.includes("2025"));
});

test("formatMessageTime returns null for invalid input", () => {
  assert.equal(formatMessageTime(null), null);
  assert.equal(formatMessageTime("invalid"), null);
});

test("formatDateDivider formats today, yesterday and dates", () => {
  assert.equal(formatDateDivider(at(2026, 9, 31, 10), (k) => k === "time.today" ? "today" : k, now), "Today");
  assert.equal(formatDateDivider(at(2026, 9, 30, 22), (k) => k === "time.yesterday" ? "yesterday" : k, now), "Yesterday");
  const older = formatDateDivider(at(2026, 9, 25, 10), null, now);
  assert.ok(older && !older.includes("2026"));
  const lastYear = formatDateDivider(at(2025, 9, 25, 10), null, now);
  assert.ok(lastYear && lastYear.includes("2025"));
  assert.equal(formatDateDivider("invalid"), null);
});
