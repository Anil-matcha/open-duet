import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnread, reconcileSeen } from "./unread.ts";

const th = (id, updated_at, archived_at = null) => ({ id, updated_at, archived_at });

test("first run: nothing is unread", () => {
  const threads = [th(1, "2026-10-30T10:00:00Z"), th(2, "2026-10-30T11:00:00Z")];
  const seen = reconcileSeen(threads, {}, null);
  assert.deepEqual(threads.map((x) => isUnread(x, seen, null)), [false, false]);
});

test("a thread that moves after it was seen becomes unread; opening it reads it", () => {
  const seen = reconcileSeen([th(1, "2026-10-30T10:00:00Z")], {}, null);
  const later = th(1, "2026-10-30T12:00:00Z");
  assert.equal(isUnread(later, seen, null), true);
  assert.equal(isUnread(later, seen, 1), false);
  const afterOpen = reconcileSeen([later], seen, 1);
  assert.equal(isUnread(later, afterOpen, null), false);
});

test("archived threads are never unread, and gone threads are dropped", () => {
  const seen = { 1: "2026-10-30T10:00:00Z", 9: "2026-10-01T00:00:00Z" };
  assert.equal(isUnread(th(1, "2026-10-31T00:00:00Z", "2026-10-31T01:00:00Z"), seen, null), false);
  assert.deepEqual(Object.keys(reconcileSeen([th(1, "2026-10-30T10:00:00Z")], seen, null)), ["1"]);
});

test("nothing changed returns the same object", () => {
  const seen = reconcileSeen([th(1, "2026-10-30T10:00:00Z")], {}, null);
  assert.equal(reconcileSeen([th(1, "2026-10-30T10:00:00Z")], seen, null), seen);
});
