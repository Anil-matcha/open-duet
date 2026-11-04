import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldNotify,
  dispatchNotification,
  getNewUnreadNotifications,
  isQuietHours,
  cleanPreviewText,
  notifyTurnCompletion,
  notifyApprovalNeeded,
} from "./desktop-notifications.ts";

const samplePrefs = {
  desktop_enabled: true,
  notify_needs_you: true,
  notify_failures: true,
  notify_task_due: true,
  notify_turn_completed: true,
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
  const itemComplete = { id: 4, kind: "turn_completed", title: "Done", body: "Output", routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" };

  // All enabled
  assert.equal(shouldNotify(itemNeedsYou, samplePrefs), true);
  assert.equal(shouldNotify(itemFail, samplePrefs), true);
  assert.equal(shouldNotify(itemDue, samplePrefs), true);
  assert.equal(shouldNotify(itemComplete, samplePrefs), true);

  // Partial preferences
  assert.equal(shouldNotify(itemNeedsYou, { ...samplePrefs, notify_needs_you: false }), false);
  assert.equal(shouldNotify(itemFail, { ...samplePrefs, notify_failures: false }), false);
  assert.equal(shouldNotify(itemDue, { ...samplePrefs, notify_task_due: false }), false);
  assert.equal(shouldNotify(itemComplete, { ...samplePrefs, notify_turn_completed: false }), false);
});

test("dispatchNotification does not notify already read items", () => {
  const readItem = { id: 5, kind: "task_due", title: "Done", body: null, routine_id: null, run_id: null, thread_id: null, read_at: "yesterday", created_at: "yesterday" };
  assert.equal(dispatchNotification(readItem, samplePrefs), false);
});

test("getNewUnreadNotifications ignores the initial baseline and old unread items", () => {
  const existingItems = [
    { id: 1, kind: "task_due", title: "A", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" },
    { id: 2, kind: "routine_failed", title: "B", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" },
  ];
  // Baseline is null
  assert.deepEqual(getNewUnreadNotifications(existingItems, null), []);

  // Baseline has id 1 and 2
  const seen = new Set([1, 2]);
  assert.deepEqual(getNewUnreadNotifications(existingItems, seen), []);

  // New item 3 arrives
  const updatedItems = [
    { id: 3, kind: "needs_you", title: "C", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" },
    ...existingItems,
  ];
  const newUnread = getNewUnreadNotifications(updatedItems, seen);
  assert.equal(newUnread.length, 1);
  assert.equal(newUnread[0].id, 3);
});

test("getNewUnreadNotifications detects new IDs even when another item was read", () => {
  const seen = new Set([1, 2]);
  const current = [
    { id: 1, kind: "task_due", title: "A", body: null, routine_id: null, run_id: null, thread_id: null, read_at: "now", created_at: "now" },
    { id: 4, kind: "routine_failed", title: "D", body: null, routine_id: null, run_id: null, thread_id: null, read_at: null, created_at: "now" },
  ];
  const result = getNewUnreadNotifications(current, seen);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 4);
});

test("isQuietHours checks overnight quiet windows", () => {
  const overnight = {
    ...samplePrefs,
    quiet_hours_enabled: true,
    quiet_hours_start: "22:00",
    quiet_hours_end: "08:00",
  };

  assert.equal(isQuietHours(overnight, new Date("2026-11-04T22:30:00")), true);
  assert.equal(isQuietHours(overnight, new Date("2026-11-04T03:15:00")), true);
  assert.equal(isQuietHours(overnight, new Date("2026-11-04T08:00:00")), false);
  assert.equal(isQuietHours(overnight, new Date("2026-11-04T14:00:00")), false);
});

test("isQuietHours checks same-day quiet windows", () => {
  const daytime = {
    ...samplePrefs,
    quiet_hours_enabled: true,
    quiet_hours_start: "13:00",
    quiet_hours_end: "15:00",
  };

  assert.equal(isQuietHours(daytime, new Date("2026-11-04T12:59:00")), false);
  assert.equal(isQuietHours(daytime, new Date("2026-11-04T13:30:00")), true);
  assert.equal(isQuietHours(daytime, new Date("2026-11-04T15:00:00")), false);
});

test("shouldNotify suppresses notifications during quiet hours", () => {
  const quietPrefs = {
    ...samplePrefs,
    quiet_hours_enabled: true,
    quiet_hours_start: "22:00",
    quiet_hours_end: "08:00",
  };
  const item = { id: 1, kind: "routine_needs_input", title: "Approval needed", body: null, routine_id: 1, run_id: 2, thread_id: null, read_at: null, created_at: "now" };
  const lateNight = new Date("2026-11-04T23:00:00");
  const afternoon = new Date("2026-11-04T15:00:00");

  assert.equal(shouldNotify(item, quietPrefs, lateNight), false);
  assert.equal(shouldNotify(item, quietPrefs, afternoon), true);
});

test("shouldNotify matches routine_needs_input and routine failure variations", () => {
  const needsInput = { id: 10, kind: "routine_needs_input", title: "Needs input", body: null, routine_id: 1, run_id: 2, thread_id: null, read_at: null, created_at: "now" };
  const missed = { id: 11, kind: "routine_missed", title: "Missed run", body: null, routine_id: 1, run_id: 3, thread_id: null, read_at: null, created_at: "now" };

  assert.equal(shouldNotify(needsInput, { ...samplePrefs, notify_needs_you: false }), false);
  assert.equal(shouldNotify(needsInput, samplePrefs), true);
  assert.equal(shouldNotify(missed, { ...samplePrefs, notify_failures: false }), false);
  assert.equal(shouldNotify(missed, samplePrefs), true);
});

test("cleanPreviewText strips markdown code fences, headers, and truncates", () => {
  const md = "### Summary\nHere is `inline code` and a block:\n```python\nprint('hello')\n```\nAll done!";
  const cleaned = cleanPreviewText(md);
  assert.ok(!cleaned.includes("###"));
  assert.ok(!cleaned.includes("```"));
  assert.ok(cleaned.includes("[code]"));
  assert.ok(cleaned.includes("All done!"));

  const long = "a".repeat(200);
  const truncated = cleanPreviewText(long, 50);
  assert.equal(truncated.length, 50);
  assert.ok(truncated.endsWith("…"));
});

test("notifyTurnCompletion and notifyApprovalNeeded respect preferences", () => {
  // If desktop_enabled is false, returns false
  assert.equal(
    notifyTurnCompletion({
      agentName: "Jai",
      text: "Done",
      status: "completed",
      threadId: 1,
      prefs: { ...samplePrefs, desktop_enabled: false },
    }),
    false
  );

  // If notify_turn_completed is false, returns false
  assert.equal(
    notifyTurnCompletion({
      agentName: "Jai",
      text: "Done",
      status: "completed",
      threadId: 1,
      prefs: { ...samplePrefs, notify_turn_completed: false },
    }),
    false
  );

  // If notify_needs_you is false, notifyApprovalNeeded returns false
  assert.equal(
    notifyApprovalNeeded({
      agentName: "Jai",
      summary: "Run script",
      approvalId: "app-1",
      threadId: 1,
      prefs: { ...samplePrefs, notify_needs_you: false },
    }),
    false
  );
});
