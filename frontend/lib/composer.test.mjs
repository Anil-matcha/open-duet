import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLongPaste, isSendKey, livePastes, removePaste } from './composer.ts';

test('Enter sends, Shift+Enter does not, and IME confirmation never does', () => {
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false }), true);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 }), false);
  assert.equal(isSendKey({ key: 'a', shiftKey: false }), false);
});

test('long pastes are detected and removable while still in the box', () => {
  assert.equal(isLongPaste('x'.repeat(800)), false);
  assert.equal(isLongPaste('x'.repeat(801)), true);
  const paste = 'y'.repeat(900);
  assert.deepEqual(livePastes(`hi ${paste}`, [paste]), [paste]);
  assert.deepEqual(livePastes('hi', [paste]), []);
  assert.equal(removePaste(`hi ${paste}`, paste), 'hi ');
});
