import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buttonName, framePoint, keyMessage, modifiers, mouseMessage, navMessage, parseServerText, textMessage, wheelMessage } from './browser-view.ts';

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
