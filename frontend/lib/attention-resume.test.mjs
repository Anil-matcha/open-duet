// Seam test: the feed items and change frames the backend pending-work route
// actually emits drive the attention surface's announce/notify logic and the
// resume surface's summary. `attention-resume-payloads.json` is written by
// `backend/tests/integration/test_attention_resume.py` (regenerated on each run);
// this test fails if the route and the consumers' contract drift apart.
//
// AC4 lives here too: the repo has no DOM harness, so the trapped-surface
// invariant is pinned by mirroring LiveDesktop's release handler through the same
// constants the component uses (`RELEASE_CHORD_KEYS` / `isReleaseChord`); the
// type-level half is `tsc` over LiveDesktop.tsx/TrappedCanvas.tsx.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  announceText,
  applySpoken,
  COALESCE_MS,
  flush,
  initialAnnounceState,
  livePriority,
  mostUrgent,
  planNotifications,
  registerChange,
  worthyOfNativeNotification,
} from './attention.ts';
import { RELEASE_CHORD_KEYS } from './a11y-invariants.ts';
import { isReleaseChord } from './desktop-rfb.ts';
import { buildResumeSummary, NEGATIVE_CLAUSE } from './resume-summary.ts';

const recorded = JSON.parse(
  readFileSync(new URL('./attention-resume-payloads.json', import.meta.url), 'utf8'),
);

// AC1: cross-thread arrival — one item naming agent B → one announcement + one
// notification. The recorded frame and focused thread (agent A) are real; the
// arrived approval carries no persisted deadline (urgency "normal"), so the
// notification artifact is asserted on the same item's expired variant (crafted in
// fixture data, never slept for).
test('AC1 recorded arrival: one announcement naming agent B and one notification', () => {
  const { items, frames, wire, focused_thread_id, notify_item } = recorded.arrival;
  assert.equal(frames.length, 1, 'exactly one change frame');
  assert.equal(frames[0].change, 'approval_added');
  assert.match(wire, /^event: pending_work\.changed\n/, 'the wire frame type the consumer reads');
  assert.match(wire, /"type": "pending_work\.changed"/);
  const approvals = items.filter((i) => i.kind === 'approval');
  assert.equal(approvals.length, 1);

  // Announce: the single item's text names agent B.
  const first = registerChange(initialAnnounceState(), approvals, 0);
  const decision = first.decision.speak ? first.decision : flush(first.state);
  assert.equal(decision.speak, true);
  assert.equal(decision.item.agent_name, 'Agent B');
  assert.match(decision.text, /Approval needed in Agent B/);

  // Notify: exactly one call for the arrived item once it is past its window; the
  // currently focused thread (agent A) suppresses its own items, not agent B's.
  const { toNotify } = planNotifications(new Set(), [notify_item], focused_thread_id);
  assert.equal(toNotify.length, 1);
  assert.equal(toNotify[0].agent_name, 'Agent B');
  assert.equal(toNotify[0].thread_id, approvals[0].thread_id);
});

// AC2: urgency gating — expired → assertive + notify; normal → polite, no notify.
test('AC2 recorded urgency: expired is assertive+notify, normal is polite+quiet', () => {
  const { items } = recorded.urgency;
  const expired = items.find((i) => i.urgency === 'expired');
  const normal = items.find((i) => i.urgency === 'normal');
  assert.ok(expired && normal);

  assert.equal(livePriority([expired]), 'assertive');
  assert.equal(livePriority([normal]), 'polite');
  assert.equal(worthyOfNativeNotification(expired), true);
  assert.equal(worthyOfNativeNotification(normal), false);

  const notified = planNotifications(new Set(), [expired, normal], null);
  assert.deepEqual(notified.toNotify.map((i) => i.urgency), ['expired']);
  assert.match(announceText(expired), /\(overdue\)/);
  assert.doesNotMatch(announceText(normal), /\(overdue\)|\(due soon\)/);
});

// AC5: load coalescing — three frames inside the window → one announcement of the
// most urgent item; the numbers (window, most-urgent item) are asserted here.
test('AC5 recorded coalescing: three frames in the window speak once, most urgent wins', () => {
  const { frames, items, focused_thread_id } = recorded.coalescing;
  assert.equal(frames.length, 3);

  assert.equal(mostUrgent(items).urgency, 'expired');

  // Three changes arriving inside COALESCE_MS collapse to a single announcement.
  let state = initialAnnounceState();
  let speaks = 0;
  let spoken = null;
  for (let i = 0; i < items.length; i++) {
    const at = i * 10; // all well within the window
    const r = registerChange(state, [items[i]], at);
    state = r.state;
    if (r.decision.speak) {
      speaks += 1;
      spoken = r.decision;
      state = applySpoken(state, r.decision);
    }
  }
  // The first window has not elapsed on any change, so nothing spoke yet.
  assert.equal(speaks, 0);
  const final = flush(state);
  assert.equal(final.speak, true);
  assert.equal(final.item.urgency, 'expired');
  assert.equal(speaks, 0, 'no change spoke prematurely inside the window');
  assert.ok(COALESCE_MS >= 30, 'the recorded steps all fall inside the window');

  // A no-focus, un-notified feed notifies only the worthy item.
  const notified = planNotifications(new Set(), items, focused_thread_id);
  assert.deepEqual(notified.toNotify.map((i) => i.urgency), ['expired']);
});

// AC3: recovery by owner action only — the recorded interrupted turn composes a
// summary through the resume surface; the summary never claims completion and the
// action only produces text to prefill (no request is made by this pure path).
test('AC3 recorded recovery: summary shows the phase and last events, never completion', () => {
  const { phase, turnId, events } = recorded.recovery;
  const summary = buildResumeSummary(events, phase, turnId);
  assert.ok(summary.hasEvents, 'the interrupted turn had an event trail');
  assert.match(summary.text, /It did not finish\./);
  assert.ok(summary.text.includes(NEGATIVE_CLAUSE));
  assert.match(summary.text, /ran Bash/);
  assert.match(summary.text, new RegExp(phase), 'the summary names the recorded phase');
  assert.doesNotMatch(summary.text, /completed|successfully/i);
});

// AC4: the trapped-surface invariant, exercised at runtime the way LiveDesktop
// does — the declared release chords are exactly the intercepted ones.
test('AC4 trapped surface: declared RELEASE_CHORD_KEYS are the intercepted chords', () => {
  const intercepted = (event) =>
    RELEASE_CHORD_KEYS.some((key) => (key === 'F6' ? event.key === 'F6' : isReleaseChord(event)));

  for (const key of RELEASE_CHORD_KEYS) {
    const event = key === 'F6'
      ? { key: 'F6' }
      : { key: 'Escape', ctrlKey: true, shiftKey: true };
    assert.equal(intercepted(event), true, `declared release key ${key} must be intercepted`);
  }
  assert.equal(intercepted({ key: 'Tab' }), false, 'Tab must not be a release chord');
  assert.equal(intercepted({ key: 'Escape' }), false, 'bare Escape is not the chord');
});

// AC6: the pure consumers of the recorded feed are side-effect-free — running the
// announce/notify logic over the payload does not change the payload.
test('AC6 verification paths do not mutate the recorded feed', () => {
  const snapshot = JSON.stringify(recorded);
  const { items } = recorded.arrival;
  registerChange(initialAnnounceState(), items, 0);
  planNotifications(new Set(), items, recorded.arrival.focused_thread_id);
  assert.equal(JSON.stringify(recorded), snapshot);
});
