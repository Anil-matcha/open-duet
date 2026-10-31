import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDraft, saveDraft } from './drafts.ts';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), size: () => m.size };
};

test('a draft is kept per conversation and cleared when emptied', () => {
  const s = memory();
  saveDraft('1', 'hello', s);
  saveDraft('2', 'other', s);
  assert.equal(loadDraft('1', s), 'hello');
  assert.equal(loadDraft('2', s), 'other');
  saveDraft('1', '   ', s);
  assert.equal(loadDraft('1', s), '');
  assert.equal(s.size(), 1);
});

test('no key or a throwing store never breaks the box', () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.equal(loadDraft(null, memory()), '');
  assert.equal(loadDraft('1', broken), '');
  assert.doesNotThrow(() => saveDraft('1', 'a', broken));
  assert.doesNotThrow(() => saveDraft('1', '', broken));
});
