import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeAccess, deviceAccess, PAIRING_CHOICES } from './access-label.ts';

test('a code is described by what it grants', () => {
  assert.equal(codeAccess('chat'), 'Chat only');
  assert.equal(codeAccess('files'), 'Chat and files');
  assert.equal(codeAccess('manage'), 'Chat, files and agents');
  assert.equal(codeAccess('admin'), 'Full access');
});

test('a device row says the same from its scopes, and admin wins', () => {
  assert.equal(deviceAccess(['chat']), 'chat only');
  assert.equal(deviceAccess(['chat', 'files']), 'chat and files');
  assert.equal(deviceAccess(['chat', 'files', 'manage']), 'chat, files and agents');
  // A session that has manage always reads as agents, whatever else it lists.
  assert.equal(deviceAccess(['chat', 'manage']), 'chat, files and agents');
  assert.equal(deviceAccess(['admin', 'chat', 'files']), 'full access');
});

test('the Access menu offers every scope the server accepts, once', () => {
  assert.deepEqual(PAIRING_CHOICES.map((choice) => choice.value).sort(), ['admin', 'chat', 'files', 'manage']);
});
