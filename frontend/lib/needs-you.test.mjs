import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, emptyTranscript } from './transcript.ts';
import { rowAction, summary } from './needs-you.ts';

let seq = 0;
const ev = (data) => ({ thread_id: 1, seq: ++seq, type: 'card.needs_you', turn_id: null, data, ts: '2026-01-01T00:00:00+00:00' });
const row = (key, kind = 'approval', thread_id = null) => ({ kind, key, title: key, detail: null, thread_id });
const card = (revision, items, day = '2026-10-24') => ({ card_id: `needs-you:${day}`, day, title: 'Needs you', subtitle: 'Saturday, 24 October', items, more: 0, empty_text: 'Nothing needs you right now.', revision });

test('a newer revision replaces the card where it stands; an older or repeated one is ignored', () => {
  seq = 0;
  const first = applyEvent(emptyTranscript(), ev(card(1, [row('a')])));
  assert.equal(first.items.length, 1);
  const second = applyEvent(first, ev(card(2, [row('a'), row('b')])));
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].key, first.items[0].key);
  assert.deepEqual(second.items[0].rows.map((r) => r.key), ['a', 'b']);
  assert.deepEqual(applyEvent(second, ev(card(1, []))).items[0].rows.length, 2);
  const tomorrow = applyEvent(second, ev(card(1, [row('c')], '2026-10-25')));
  assert.equal(tomorrow.items.length, 2);
});

test('an emptied card stays and says nothing needs the person; malformed cards only move the cursor', () => {
  seq = 0;
  const state = applyEvent(applyEvent(emptyTranscript(), ev(card(1, [row('a')]))), ev(card(2, [])));
  assert.equal(state.items[0].rows.length, 0);
  assert.equal(state.items[0].emptyText, 'Nothing needs you right now.');
  const bad = applyEvent(emptyTranscript(), ev({ card_id: 5 }));
  assert.equal(bad.items.length, 0);
  assert.equal(bad.lastSeq, seq);
});

test('rows drop what is not a row and each kind has one action', () => {
  seq = 0;
  const state = applyEvent(emptyTranscript(), ev(card(1, [row('a'), { nope: 1 }])));
  assert.equal(state.items[0].rows.length, 1);
  assert.deepEqual(rowAction(row('x', 'approval', 9)), { label: 'Review', href: '/chat?thread=9' });
  assert.deepEqual(rowAction(row('x', 'signed_out')), { label: 'Open settings', href: '/settings/engines/' });
  assert.equal(rowAction(row('x', 'usage_limit')).href, '/chat?panel=usage');
});

test('the summary counts the hidden rows too', () => {
  assert.equal(summary(0, 0), 'Nothing needs you right now.');
  assert.equal(summary(1, 0), '1 thing needs you');
  assert.equal(summary(6, 3), '9 things need you');
});

test('Today keeps source freshness and routes to the exact routine or task', () => {
  const data = { ...card(1, [{ ...row('completed:7', 'routine_completed'), routine_id: 7,
    source: 'Routine runs', at: '2026-10-24T10:00:00Z' }]), title: 'Today',
    checked_at: '2026-10-24T10:01:00Z', time_zone: 'Asia/Kolkata',
    sources: { calendar: 'unavailable', gmail: 'unavailable', local: 'available' } };
  const item = applyEvent(emptyTranscript(), ev(data)).items[0];
  assert.equal(item.checkedAt, data.checked_at);
  assert.equal(item.timeZone, data.time_zone);
  assert.equal(item.rows[0].source, 'Routine runs');
  assert.equal(item.rows[0].at, data.items[0].at);
  assert.deepEqual(rowAction(item.rows[0]), { label: 'View runs', href: '/chat?view=routines&routine=7' });
  assert.deepEqual(rowAction({ ...row('due:8', 'due'), work_item_id: 8 }), { label: 'Review task', href: '/chat?view=planner&task=8' });
});
