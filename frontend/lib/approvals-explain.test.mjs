import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alsoAllowsExpanded,
  batchGate,
  explainView,
  floorBadge,
  matchedRuleText,
  previewView,
  resolvedCommandText,
  runBatchApprove,
} from './approvals.ts';

const payload = (over = {}) => ({
  command: "rm -rf ~",
  resolved_argv: ['rm', '-rf', '~'],
  wrapper_chain: [],
  value_options_resolved: [],
  matched_rule: null,
  floor_verdict: { clear: false, tripped_check: 'delete-home', reason: 'removes the home directory', skipped_reason: null },
  also_allows: [],
  ...over,
});

test('resolvedCommandText joins argv and annotates wrappers', () => {
  assert.equal(resolvedCommandText(payload()), 'rm -rf ~');
  const wrapped = resolvedCommandText(
    payload({ resolved_argv: ['rm', '-rf', '~'], wrapper_chain: ['env'], value_options_resolved: [['-S', 'rm -rf ~']] }),
  );
  assert.match(wrapped, /^rm -rf ~\nthrough env \(-S rm -rf ~\)$/);
});

test('matchedRuleText is explicit when no rule matched', () => {
  assert.equal(matchedRuleText(null), 'No saved rule');
  assert.equal(
    matchedRuleText({ id: 1, kind: 'prefix', command: 'git status', workspace: '/work' }),
    'Starts with “git status” in /work',
  );
  assert.equal(
    matchedRuleText({ id: 2, kind: 'exact', command: 'npm test', workspace: null }),
    'Exactly “npm test” in every folder',
  );
});

test('floorBadge reflects the payload verbatim, never recomputes', () => {
  assert.deepEqual(floorBadge({ clear: true, tripped_check: null, reason: null, skipped_reason: null }), {
    clear: true,
    label: 'Safe floor check passed',
    detail: null,
  });
  const held = floorBadge({ clear: false, tripped_check: 'force-push', reason: 'rewrites history', skipped_reason: null });
  assert.equal(held.clear, false);
  assert.equal(held.detail, 'force-push: rewrites history');
});

test('explainView degrades visibly when the payload is missing or failed', () => {
  const loading = explainView(null, { loading: true });
  assert.equal(loading.state, 'loading');
  const failed = explainView(null, { failed: true });
  assert.equal(failed.state, 'unavailable');
  assert.match(failed.banner, /Explanation unavailable/);
  const none = explainView(null);
  assert.equal(none.state, 'unavailable');
});

test('explainView shapes the ready sections from the payload', () => {
  const view = explainView(payload({ matched_rule: { id: 1, kind: 'exact', command: 'rm -rf ~', workspace: null }, also_allows: ['rm -rf /tmp/x'] }));
  assert.equal(view.state, 'ready');
  assert.equal(view.sections.matchedRule, 'Exactly “rm -rf ~” in every folder');
  assert.equal(view.sections.alsoAllowsExpanded, true);
  assert.deepEqual(view.sections.alsoAllows, ['rm -rf /tmp/x']);
  assert.equal(alsoAllowsExpanded(payload()), false);
});

test('batchGate refuses empty and mixed-tool selections', () => {
  assert.equal(batchGate([]).enabled, false);
  const mixed = batchGate([
    { id: 'a', tool: 'Bash', floorClear: true },
    { id: 'b', tool: 'Edit', floorClear: true },
  ]);
  assert.equal(mixed.enabled, false);
  assert.match(mixed.reason, /Mixed tool types/);
});

test('batchGate refuses any not-confirmed-clear item (anti-rubber-stamp)', () => {
  const g = batchGate([
    { id: 'a', tool: 'Bash', floorClear: true },
    { id: 'b', tool: 'Bash', floorClear: false },
    { id: 'c', tool: 'Bash', floorClear: null },
  ]);
  assert.equal(g.enabled, false);
  assert.match(g.reason, /2 selected item\(s\) are not safe-floor/);
});

test('batchGate enables only a non-empty, homogeneous, all-clear selection', () => {
  const g = batchGate([
    { id: 'a', tool: 'Bash', floorClear: true },
    { id: 'b', tool: 'Bash', floorClear: true },
  ]);
  assert.deepEqual(g, { enabled: true, reason: null, count: 2 });
});

test('runBatchApprove fans out one call per item and reports failures per item', async () => {
  const calls = [];
  const outcomes = await runBatchApprove([{ id: 'a' }, { id: 'b' }, { id: 'c' }], async (id) => {
    calls.push(id);
    if (id === 'b') throw new Error('no longer waiting');
    return 'ok';
  });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(outcomes, [
    { id: 'a', ok: true, error: null },
    { id: 'b', ok: false, error: 'no longer waiting' },
    { id: 'c', ok: true, error: null },
  ]);
});

test('previewView gates save on a clear floor and surfaces would_allow verbatim', () => {
  const noPreview = previewView(null);
  assert.equal(noPreview.canSave, false);
  const errored = previewView(null, { error: 'not a shell command' });
  assert.match(errored.floorLabel, /Cannot preview: not a shell command/);
  const clear = previewView({
    would_allow: ['rm -rf /tmp/x', 'git push --force'],
    would_reject: [],
    floor_state: { clear: true, tripped_check: null, reason: null, skipped_reason: null },
  });
  assert.equal(clear.canSave, true);
  assert.deepEqual(clear.wouldAllow, ['rm -rf /tmp/x', 'git push --force']);
  const held = previewView({
    would_allow: [],
    would_reject: [],
    floor_state: { clear: false, tripped_check: 'force-push', reason: null, skipped_reason: null },
  });
  assert.equal(held.canSave, false);
  assert.equal(held.floorLabel, 'Held by the safety floor');
});
