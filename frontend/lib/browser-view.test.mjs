import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonName, canDrive, framePoint, keyMessage, modifiers, mouseMessage, navMessage, parseServerText, retryDelayMs, textMessage, viewNote, viewState, wheelMessage } from './browser-view.ts';

const rect = { left: 10, top: 20, width: 640, height: 400 };
const size = { w: 1280, h: 800 };

test('the pointer is mapped from the canvas on screen to the page pixels', () => {
  assert.deepEqual(framePoint(rect, size, 330, 220), { x: 640, y: 400 });
  assert.deepEqual(framePoint(rect, size, 10, 20), { x: 0, y: 0 });
  assert.equal(framePoint(rect, size, 9, 100), null);
  assert.equal(framePoint(rect, size, 700, 100), null);
  assert.equal(framePoint({ ...rect, width: 0 }, size, 20, 30), null);
  assert.equal(framePoint(rect, { w: 0, h: 0 }, 20, 30), null);
});

test('mouse, wheel, text and address messages', () => {
  assert.deepEqual(mouseMessage('down', { x: 1, y: 2 }, 2), { t: 'mouse', a: 'down', x: 1, y: 2, b: 'right' });
  assert.equal(buttonName(1), 'middle');
  assert.equal(buttonName(0), 'left');
  assert.deepEqual(wheelMessage({ x: 1, y: 2 }, 0.4, 99.6), { t: 'wheel', x: 1, y: 2, dx: 0, dy: 100 });
  assert.equal(textMessage(''), null);
  assert.equal(textMessage('x'.repeat(3000)).text.length, 2000);
  assert.deepEqual(navMessage(' example.com/a '), { t: 'nav', url: 'https://example.com/a' });
  assert.deepEqual(navMessage('http://example.com'), { t: 'nav', url: 'http://example.com' });
  assert.equal(navMessage('   '), null);
});

test('keys: named and printable are relayed with modifier bits, others are not', () => {
  assert.deepEqual(keyMessage({ key: 'Enter' }, 'down'), { t: 'key', a: 'down', key: 'Enter', mods: 0 });
  assert.deepEqual(keyMessage({ key: 'A', shiftKey: true }, 'up'), { t: 'key', a: 'up', key: 'A', mods: 8 });
  assert.equal(modifiers({ key: 'a', altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
  assert.equal(keyMessage({ key: 'F5' }, 'down'), null);
  assert.equal(keyMessage({ key: 'Dead' }, 'down'), null);
  assert.equal(keyMessage({ key: 'Shift' }, 'down'), null);
});

test('server text messages', () => {
  assert.deepEqual(parseServerText('{"t":"size","w":1000,"h":600}'), { kind: 'size', size: { w: 1000, h: 600 } });
  assert.deepEqual(parseServerText('{"t":"refused","text":"No."}'), { kind: 'refused', text: 'No.' });
  assert.equal(parseServerText('{"t":"size","w":0,"h":600}'), null);
  assert.equal(parseServerText('nonsense'), null);
});

test('watching starts view-only and only taking control makes the session drive', () => {
  assert.equal(viewState('starting', 'frame'), 'watching');
  assert.equal(viewState('watching', 'take'), 'taking');
  assert.equal(viewState('taking', 'frame'), 'driving');
  assert.equal(canDrive('watching'), false);
  assert.equal(canDrive('taking'), false);
  assert.equal(canDrive('driving'), true);
  assert.equal(viewState('starting', 'take'), 'starting'); // not before there is a picture
  assert.equal(viewState('waiting', 'take'), 'waiting');
});

test('handing control back returns to watching, and a failed take falls back to watching', () => {
  for (const from of ['driving', 'lost', 'taking']) assert.equal(viewState(from, 'release'), 'starting');
  assert.equal(viewState('taking', 'failed'), 'watching');
  assert.equal(viewState('watching', 'failed'), 'watching');
  assert.equal(viewState('lost', 'take'), 'taking'); // reconnect with the same lease
});

test('a dropped watch reconnects quietly; only a held session shows lost', () => {
  assert.equal(viewState('watching', 'drop'), 'starting');
  assert.equal(viewState('driving', 'drop'), 'lost');
  assert.equal(viewState('lost', 'drop'), 'lost');
  assert.equal(viewState('watching', 'notrunning'), 'waiting');
  assert.equal(viewState('driving', 'notrunning'), 'driving'); // a held session keeps its own warning
  assert.equal(viewState('waiting', 'frame'), 'watching');
});

test('retries back off, and a browser that is not running is polled gently', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(n => retryDelayMs(n)), [1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(retryDelayMs(7, true), 5000);
});

test('the plain notes name the state and only the held session warns about the 20 seconds', () => {
  assert.match(viewNote('waiting'), /not running right now/);
  assert.match(viewNote('watching'), /keeps working/);
  assert.match(viewNote('lost'), /20 seconds/);
  for (const state of ['waiting', 'starting', 'watching', 'taking', 'driving']) assert.doesNotMatch(viewNote(state), /Connection lost|20 seconds/);
});
