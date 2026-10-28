const test = require("node:test");
const assert = require("node:assert/strict");
const { registerDesktopPermissions } = require("../src/desktop-permissions");

function setup(platform = "darwin") {
  let handler;
  const panes = [];
  const mainFrame = { url: "http://127.0.0.1:1234/onboarding/" };
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame };
  const prefs = { isTrustedAccessibilityClient: prompt => { assert.equal(prompt, false); return false; }, getMediaAccessStatus: () => "denied" };
  registerDesktopPermissions({ ipcMain: { handle: (_, fn) => { handler = fn; } }, systemPreferences: prefs, openExternal: async url => panes.push(url), getWindow: () => ({ webContents }), getOrigin: () => "http://127.0.0.1:1234", platform });
  return { handler, event, panes, prefs };
}

test("permission reads do not prompt; only fixed system panes can open", async () => {
  const { handler, event, panes, prefs } = setup();
  assert.deepEqual(await handler(event), { supported: true, accessibility: false, screen_recording: false });
  assert.deepEqual(panes, []);
  await handler(event, "screen_recording");
  assert.equal(panes.length, 1);
  assert.ok(panes[0].endsWith("Privacy_ScreenCapture"));
  prefs.getMediaAccessStatus = () => "granted";
  assert.equal((await handler(event)).screen_recording, true);
  await assert.rejects(handler(event, "https://arbitrary.example"));
});

test("untrusted frame, other origin and wrong page cannot open permissions", async () => {
  const { handler, event } = setup();
  await assert.rejects(handler({ ...event, senderFrame: { url: event.senderFrame.url } }));
  event.senderFrame.url = "https://other.example/settings/";
  await assert.rejects(handler(event));
  event.senderFrame.url = "http://127.0.0.1:1234/chat/";
  await assert.rejects(handler(event));
});

test("non-Mac builds report unavailable without invoking OS permission APIs", async () => {
  const { handler, event, panes } = setup("win32");
  assert.equal((await handler(event, "accessibility")).supported, false);
  assert.deepEqual(panes, []);
});
