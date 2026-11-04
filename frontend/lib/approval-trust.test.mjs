// Seam test: the payload keys the backend explain route actually emits drive the
// card's shaping functions. `approval-trust-payloads.json` is written by
// `backend/tests/integration/test_approval_trust.py` (regenerated on each run);
// this test fails if the endpoint and the card contract drift apart.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { batchGate, explainView, floorBadge, matchedRuleText, resolvedCommandText } from './approvals.ts';

const recorded = JSON.parse(
  readFileSync(new URL('./approval-trust-payloads.json', import.meta.url), 'utf8'),
);

test('recorded wrapper payload carries every key the card reads', () => {
  const p = recorded.wrapper_explain;
  for (const key of [
    'command',
    'resolved_argv',
    'wrapper_chain',
    'value_options_resolved',
    'matched_rule',
    'floor_verdict',
    'also_allows',
  ]) {
    assert.ok(key in p, `explain payload is missing '${key}' — endpoint/card contract drift`);
  }
});

test('the recorded wrapper payload renders as the blocked-consequence card', () => {
  const view = explainView(recorded.wrapper_explain);
  assert.equal(view.state, 'ready');
  assert.equal(view.sections.resolvedCommand, "env -S rm -rf ~\nthrough env (-S rm -rf ~)");
  assert.equal(view.sections.matchedRule, 'No saved rule');
  assert.equal(view.sections.floor.clear, false);
  assert.equal(view.sections.floor.detail, 'delete-home: recursive delete of the home directory');
  assert.deepEqual(view.sections.alsoAllows, []);
});

test('floorBadge and matchedRuleText agree with the raw payload fields', () => {
  const p = recorded.wrapper_explain;
  assert.deepEqual(floorBadge(p.floor_verdict).clear, p.floor_verdict.clear);
  assert.equal(matchedRuleText(p.matched_rule), 'No saved rule');
  assert.equal(resolvedCommandText(p), "env -S rm -rf ~\nthrough env (-S rm -rf ~)");
});

test('a batch of the recorded wrapper item is refused (not floor-clear)', () => {
  const p = recorded.wrapper_explain;
  const gate = batchGate([{ id: 'wrapper', tool: 'Bash', floorClear: p.floor_verdict.clear }]);
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /not safe-floor/);
});
