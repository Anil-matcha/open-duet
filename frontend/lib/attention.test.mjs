import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  announceText,
  applySpoken,
  bellCountAnnouncement,
  COALESCE_MS,
  desktopNotifier,
  flush,
  initialAnnounceState,
  itemKey,
  livePriority,
  mostUrgent,
  planNotifications,
  registerChange,
  worthyOfNativeNotification,
} from './attention.ts';

const item = (over = {}) => ({
  kind: 'approval',
  thread_id: 1,
  agent_id: null,
  agent_name: 'Agent A',
  title: 'Run the tests',
  created_at: '2026-10-25T09:00:00Z',
  deadline: null,
  urgency: 'normal',
  ...over,
});

test('announceText derives from the item, names the agent and urgency', () => {
  assert.equal(announceText(item()), 'Approval needed in Agent A: Run the tests');
  assert.match(announceText(item({ urgency: 'due' })), /due soon/);
  assert.match(announceText(item({ urgency: 'expired' })), /overdue/);
  assert.equal(announceText(item({ kind: 'needs_you', title: 'Sign in' })), 'Needs you in Agent A: Sign in');
  assert.equal(announceText(item({ agent_name: null, thread_id: 7 })), 'Approval needed in thread 7: Run the tests');
});

test('livePriority is assertive only when something is expired or due', () => {
  assert.equal(livePriority([item({ urgency: 'normal' })]), 'polite');
  assert.equal(livePriority([item({ urgency: 'normal' }), item({ urgency: 'due' })]), 'assertive');
  assert.equal(livePriority([item({ urgency: 'expired' })]), 'assertive');
});

test('only expired/due items are worthy of a native notification', () => {
  assert.equal(worthyOfNativeNotification(item({ urgency: 'normal' })), false);
  assert.equal(worthyOfNativeNotification(item({ urgency: 'due' })), true);
  assert.equal(worthyOfNativeNotification(item({ urgency: 'expired' })), true);
});

test('mostUrgent picks the most urgent, newest on a tie', () => {
  const older = item({ urgency: 'due', created_at: '2026-10-25T09:00:00Z' });
  const newer = item({ urgency: 'due', created_at: '2026-10-25T09:05:00Z' });
  const normal = item({ urgency: 'normal' });
  assert.equal(mostUrgent([normal, older, newer]), newer);
  assert.equal(mostUrgent([item({ urgency: 'expired', created_at: '2026-10-25T08:00:00Z' }), newer]).urgency, 'expired');
  assert.equal(mostUrgent([]), null);
});

test('AC1/coalescing: a change is spoken by the window flush, and the same item never repeats', () => {
  let state = initialAnnounceState();
  const first = registerChange(state, [item()], 1000);
  state = first.state;
  // The window opens; nothing speaks until the flush (coalescing).
  assert.equal(first.decision.speak, false);
  const spoken = flush(state);
  assert.equal(spoken.speak, true);
  assert.equal(spoken.speak && spoken.text, 'Approval needed in Agent A: Run the tests');
  state = applySpoken(state, spoken);

  // The same item, still in the feed: no repeat.
  const again = registerChange(state, [item()], 5000);
  assert.equal(again.decision.speak, false);
});

test('AC6: three rapid changes coalesce into one announcement naming the most urgent', () => {
  let state = initialAnnounceState();
  const now = 1000;
  const a = registerChange(state, [item({ title: 'A', urgency: 'normal' })], now);
  state = a.state;
  assert.equal(a.decision.speak, false, 'inside the window: coalesce, do not speak');

  // Two more inside the window do not speak yet.
  const b = registerChange(state, [item({ title: 'B', urgency: 'normal', thread_id: 2 })], now + 100);
  state = b.state;
  const c = registerChange(state, [item({ title: 'C', urgency: 'due', thread_id: 3, created_at: '2026-10-25T09:02:00Z' })], now + 200);
  state = c.state;
  assert.equal(b.decision.speak, false);
  assert.equal(c.decision.speak, false);

  // The scheduled flush speaks once, the due item wins.
  const spoken = flush(state);
  assert.equal(spoken.speak, true);
  assert.equal(spoken.speak && spoken.item.title, 'C');
  assert.equal(spoken.speak && spoken.priority, 'assertive');
});

test('AC3: quiet frames (no items) produce no announcement', () => {
  const state = initialAnnounceState();
  const quiet = registerChange(state, [], 1000);
  assert.equal(quiet.decision.speak, false);
  assert.equal(quiet.state.pending.length, 0);
});

test('AC7: notification planning is deduped per item and suppresses the focused thread', () => {
  const dueA = item({ title: 'A', urgency: 'due', thread_id: 1 });
  const dueB = item({ title: 'B', urgency: 'due', thread_id: 2 });
  const normalC = item({ title: 'C', urgency: 'normal', thread_id: 3 });

  const first = planNotifications(new Set(), [dueA, dueB, normalC], null);
  assert.deepEqual(first.toNotify.map((i) => i.title), ['A', 'B']); // normal excluded
  const second = planNotifications(first.notified, [dueA, dueB], null);
  assert.deepEqual(second.toNotify, []); // deduped

  const focused = planNotifications(new Set(), [dueA, dueB], 2);
  assert.deepEqual(focused.toNotify.map((i) => i.title), ['A']); // thread 2 suppressed
});

test('AC7: desktopNotifier is a no-op without the shell API and forwards with it', () => {
  const calls = [];
  const absent = desktopNotifier(undefined);
  assert.doesNotThrow(() => absent.notify({ title: 't', body: 'b', threadId: 1 }));
  const present = desktopNotifier({ notifications: { show: (p) => calls.push(p) } });
  present.notify({ title: 't', body: 'b', threadId: 1 });
  assert.deepEqual(calls, [{ title: 't', body: 'b', threadId: 1 }]);
  const malformed = desktopNotifier({ notifications: { show: 'nope' } });
  assert.doesNotThrow(() => malformed.notify({ title: 't', body: 'b', threadId: null }));
});

test('AC4: bellCountAnnouncement speaks only on a change', () => {
  assert.equal(bellCountAnnouncement(2, 2), '');
  assert.equal(bellCountAnnouncement(0, 3), '3 unread notifications.');
  assert.equal(bellCountAnnouncement(0, 1), '1 unread notification.');
  assert.equal(bellCountAnnouncement(3, 0), 'No unread notifications.');
});

test('itemKey is stable and distinguishes items', () => {
  assert.equal(itemKey(item()), itemKey(item()));
  assert.notEqual(itemKey(item()), itemKey(item({ thread_id: 2 })));
  assert.notEqual(itemKey(item()), itemKey(item({ title: 'Other' })));
});

test('COALESCE_MS is a documented short window', () => {
  assert.equal(typeof COALESCE_MS, 'number');
  assert.ok(COALESCE_MS > 0 && COALESCE_MS <= 2000);
});
