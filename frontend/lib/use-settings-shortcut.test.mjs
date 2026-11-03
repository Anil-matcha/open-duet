import assert from 'node:assert/strict';
import test from 'node:test';
import { bindSettingsShortcut, isSettingsPath, shouldOpenSettingsForKey } from './settings-shortcut.ts';

function keyEvent(overrides = {}) {
  return {
    key: ',',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}

function harness({ pathname = '/chat/', platform = 'MacIntel', dialogIsOpen = false } = {}) {
  let listener;
  let removed = false;
  let menuListener;
  let menuUnlistened = false;
  let navigations = 0;
  const eventTarget = {
    addEventListener(type, callback, capture) {
      assert.equal(type, 'keydown');
      assert.equal(capture, true);
      listener = callback;
    },
    removeEventListener(type, callback, capture) {
      assert.equal(type, 'keydown');
      assert.equal(callback, listener);
      assert.equal(capture, true);
      removed = true;
    },
  };
  const cleanup = bindSettingsShortcut({
    eventTarget,
    pathname,
    platform,
    navigate: () => { navigations += 1; },
    dialogOpen: () => dialogIsOpen,
    bridge: {
      onSettingsRequested(callback) {
        menuListener = callback;
        return () => { menuUnlistened = true; };
      },
    },
  });
  return {
    get navigations() { return navigations; },
    get removed() { return removed; },
    get menuUnlistened() { return menuUnlistened; },
    key(event) { listener(event); },
    menuRequest() { menuListener(); },
    cleanup,
  };
}

test('recognizes the settings route and Cmd/Ctrl+, on the matching platform', () => {
  assert.equal(isSettingsPath('/settings'), true);
  assert.equal(isSettingsPath('/settings/engines/'), true);
  assert.equal(isSettingsPath('/chat/'), false);
  assert.equal(shouldOpenSettingsForKey(keyEvent({ metaKey: true }), '/chat/', 'MacIntel', false), true);
  assert.equal(shouldOpenSettingsForKey(keyEvent({ ctrlKey: true }), '/chat/', 'Win32', false), true);
  assert.equal(shouldOpenSettingsForKey(keyEvent({ ctrlKey: true }), '/chat/', 'Linux x86_64', false), true);
});

test('the mounted listener routes from focused fields and the desktop menu bridge', () => {
  const app = harness();
  const event = keyEvent({ metaKey: true, target: { tagName: 'TEXTAREA' } });

  app.key(event);
  app.menuRequest();

  assert.equal(app.navigations, 2);
  assert.equal(event.prevented, true);
});

test('does not navigate during IME composition, in settings, or while a modal is open', () => {
  for (const event of [
    keyEvent({ metaKey: true, isComposing: true }),
    keyEvent({ metaKey: true, keyCode: 229 }),
    keyEvent({ metaKey: true, altKey: true }),
  ]) {
    assert.equal(shouldOpenSettingsForKey(event, '/chat/', 'MacIntel', false), false);
  }
  assert.equal(shouldOpenSettingsForKey(keyEvent({ metaKey: true }), '/settings/profile/', 'MacIntel', false), false);
  assert.equal(shouldOpenSettingsForKey(keyEvent({ metaKey: true }), '/chat/', 'MacIntel', true), false);

  const inDialog = harness({ dialogIsOpen: true });
  const event = keyEvent({ metaKey: true });
  inDialog.key(event);
  inDialog.menuRequest();
  assert.equal(inDialog.navigations, 0);
  assert.equal(event.prevented, undefined);
});

test('ignores the other platform modifier and unregisters both listeners', () => {
  const app = harness({ platform: 'Win32' });
  const event = keyEvent({ metaKey: true });

  app.key(event);
  assert.equal(app.navigations, 0);
  app.cleanup();
  assert.equal(app.removed, true);
  assert.equal(app.menuUnlistened, true);
});
