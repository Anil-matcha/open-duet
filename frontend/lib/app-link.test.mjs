import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPairLink } from './app-link.ts';

test('the app link names the server and carries the code in the fragment', () => {
  assert.equal(
    appPairLink('https://dots.example.com', 'ABCD-EFGH'),
    'suparagent://pair?server=https%3A%2F%2Fdots.example.com#code=ABCD-EFGH',
  );
});

test('a port and an unusual character are encoded', () => {
  const link = appPairLink('https://dots.example.com:8443', 'AB&D-EFGH');
  assert.ok(link.includes('server=https%3A%2F%2Fdots.example.com%3A8443'));
  assert.ok(link.endsWith('#code=AB%26D-EFGH'));
});
