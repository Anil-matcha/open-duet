import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldNotify, dispatchNotification, getNewUnreadNotifications } from "./desktop-notifications.ts";

const samplePrefs = {
  desktop_enabled: true,
  notify_needs_you: true,
  notify_failures: true,
  notify_task_due: true,
  sound_enabled: false,
};

test("shouldNotify respects desktop_enabled master toggle", () => {
  const disabled = { ...samplePrefs, desktop_enabled: false };
  const item = { id: 1, kind: "needs_you", title: "Agent needs decision", body: "Approve bash?", routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" };
  assert.equal(shouldNotify(item, disabled), false);
});

test("shouldNotify categorizes needs_you, failures, and task deadlines", () => {
  const itemNeedsYou = { id: 1, kind: "needs_you", title: "Input needed", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" };
  const itemFail = { id: 2, kind: "routine_failed", title: "Routine failed", body: "Syntax error", routine_id: 1, run_id: 2, thread_id: null, read_at: null, created_at: "now" };
  const itemDue = { id: 3, kind: "task_due", title: "Task due", body: "Review deck", routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" };

  // All enabled
  assert.equal(shouldNotify(itemNeedsYou, samplePrefs), true);
  assert.equal(shouldNotify(itemFail, samplePrefs), true);
  assert.equal(shouldNotify(itemDue, samplePrefs), true);

  // Partial preferences
  assert.equal(shouldNotify(itemNeedsYou, { ...samplePrefs, notify_needs_you: false }), false);
  assert.equal(shouldNotify(itemFail, { ...samplePrefs, notify_failures: false }), false);
  assert.equal(shouldNotify(itemDue, { ...samplePrefs, notify_task_due: false }), false);
});

test("dispatchNotification does not notify already read items", () => {
  const readItem = { id: 100, kind: "needs_you", title: "Input needed", body: null, routine_id: null, run_id: null, thread_id: null, read_at: "2026-11-03T10:00:00Z", created_at: "now" };
  assert.equal(dispatchNotification(readItem, samplePrefs), false);
});

test("getNewUnreadNotifications ignores the initial baseline and old unread items", () => {
  const existingUnread = { id: 1, kind: "needs_you", title: "Existing", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "then" };
  assert.deepEqual(getNewUnreadNotifications([existingUnread], null), []);
  assert.deepEqual(getNewUnreadNotifications([existingUnread], new Set([1])), []);
});

test("getNewUnreadNotifications detects new IDs even when another item was read", () => {
  const readItem = { id: 1, kind: "needs_you", title: "Read", body: null, routine_id: null, run_id: null, thread_id: null, read_at: "now", created_at: "then" };
  const newItem = { id: 2, kind: "needs_you", title: "New", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" };
  assert.deepEqual(getNewUnreadNotifications([readItem, newItem], new Set([1])), [newItem]);
});

