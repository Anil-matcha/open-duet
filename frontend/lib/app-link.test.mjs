import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPairLink, appServerOrigin } from './app-link.ts';

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

test('the phone calls the page origin when the API is served from it', () => {
  assert.equal(appServerOrigin('https://dots.example.com', '/api/v1'), 'https://dots.example.com');
  assert.equal(appServerOrigin('https://dots.example.com', 'https://dots.example.com/api/v1'), 'https://dots.example.com');
});

test('a separate API origin is used instead of the UI origin', () => {
  assert.equal(appServerOrigin('https://app.example.com', 'https://api.example.com/api/v1'), 'https://api.example.com');
});

test('a loopback API host takes the host the page was opened from', () => {
  assert.equal(appServerOrigin('http://192.168.1.10:3000', 'http://localhost:8000/api/v1'), 'http://192.168.1.10:8000');
  assert.equal(appServerOrigin('http://localhost:3000', 'http://localhost:8000/api/v1'), 'http://localhost:8000');
});

test('an unreadable origin falls back to the page origin', () => {
  assert.equal(appServerOrigin('http://192.168.1.10:3000', 'not a url'), 'http://192.168.1.10:3000');
});
