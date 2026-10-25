import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildResumeSummary,
  claimsCompletion,
  eventLines,
  isInterrupted,
  NEGATIVE_CLAUSE,
  phaseLabel,
} from './resume-summary.ts';

const tool = (tool, summary, turnId = 1) => ({ kind: 'tool', turnId, tool, summary });
const reply = (text, turnId = 1) => ({ kind: 'assistant', turnId, text });

test('AC7 summary template: names the phase, the digest, and the fixed negative clause', () => {
  const summary = buildResumeSummary(
    [tool('Bash', 'ran pytest'), tool('Write', 'wrote 2 files'), tool('Bash', 'requested approval')],
    'after_accept',
    1,
  );
  assert.equal(
    summary.text,
    'Restarting after an interruption: the previous turn reached after_accept. It had run: ran Bash; ran Write; ran Bash. It did not finish.',
  );
  assert.ok(summary.text.includes(NEGATIVE_CLAUSE));
});

test('AC7 the summary never claims completion', () => {
  for (const phase of ['before_accept', 'after_accept', 'unknown', '']) {
    const summary = buildResumeSummary([tool('Bash', 'ran pytest')], phase, 1);
    assert.equal(claimsCompletion(summary.text), null, `${phase} produced a completion claim`);
  }
});

test('AC4 summary fails closed when there are no stored events', () => {
  const summary = buildResumeSummary([], 'after_accept', 1);
  assert.equal(summary.hasEvents, false);
  assert.ok(summary.text.includes('(details unavailable)'));
  assert.ok(summary.text.includes(NEGATIVE_CLAUSE));
  // and never an optimistic line
  assert.equal(claimsCompletion(summary.text), null);
});

test('AC4 a tool with no name fails closed on that line', () => {
  const lines = eventLines([tool('', ''), tool('Bash', 'ran pytest')], 1);
  assert.equal(lines[0], 'ran a tool (details unavailable)');
  assert.equal(lines[1], 'ran Bash');
});

test('digest only includes events of the interrupted turn', () => {
  const lines = eventLines([tool('Bash', 'ran pytest', 1), tool('Write', 'wrote 2 files', 2)], 1);
  assert.deepEqual(lines, ['ran Bash']);
});

test('AC1 the surface is eligible only for interrupted turns', () => {
  assert.equal(isInterrupted('interrupted'), true);
  for (const status of ['succeeded', 'failed', 'cancelled', 'running']) {
    assert.equal(isInterrupted(status), false, status);
  }
});

test('phaseLabel renders unknown as unknown, never inferred', () => {
  assert.equal(phaseLabel('before_accept'), 'before_accept');
  assert.equal(phaseLabel('after_accept'), 'after_accept');
  assert.equal(phaseLabel('unknown'), 'unknown');
  assert.match(phaseLabel(''), /not recorded/);
});

test('an assistant reply is summarised without echoing its text', () => {
  const lines = eventLines([reply('Here is a long answer with secrets-shaped text')], 1);
  assert.deepEqual(lines, ['wrote a reply']);
});
