const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateComposioLinkUrl, registerComposioLink } = require("../src/composio-link");

const origin = "http://127.0.0.1:51234";
const valid = "https://connect.composio.dev/link/lk_abc123";

test("opens only https links on composio.dev, from the Settings window", async () => {
  assert.equal(validateComposioLinkUrl(valid), valid);
  assert.equal(validateComposioLinkUrl("https://composio.dev/x"), "https://composio.dev/x");
  const opened = [];
  const window = { webContents: { getURL: () => `${origin}/settings/` } };
  let handler;
  registerComposioLink({ ipcMain: { handle: (_channel, fn) => { handler = fn; } }, openExternal: async (url) => opened.push(url), getWindow: () => window, getOrigin: () => origin });
  await handler({ sender: window.webContents }, valid);
  assert.deepEqual(opened, [valid]);
});

test("rejects other hosts, schemes, credentials, ports, odd shapes", () => {
  for (const raw of [
    "https://composio.dev.evil.test/x",
    "https://evilcomposio.dev/x",
    "https://connect.composio.dev@evil.test/x",
    "https://user:pw@connect.composio.dev/x",
    "https://connect.composio.dev:8443/x",
    "http://connect.composio.dev/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://connect.composio.dev/x y",
    `https://connect.composio.dev/${"a".repeat(5000)}`,
    "https://connect.composio.dev/x#frag",
    "", "not a url", null, undefined, 42, {},
  ]) assert.throws(() => validateComposioLinkUrl(raw), undefined, String(raw));
});

test("rejects IPC calls from a foreign origin or a stale window", async () => {
  for (const { windowUrl, senderIsWindow } of [{ windowUrl: "https://evil.test/settings/", senderIsWindow: true }, { windowUrl: `${origin}/settings/`, senderIsWindow: false }]) {
    const window = { webContents: { getURL: () => windowUrl } };
    const sender = senderIsWindow ? window.webContents : { getURL: () => `${origin}/settings/` };
    let handler;
    const opened = [];
    registerComposioLink({ ipcMain: { handle: (_channel, fn) => { handler = fn; } }, openExternal: async (value) => opened.push(value), getWindow: () => window, getOrigin: () => origin });
    await assert.rejects(handler({ sender }, valid));
    assert.deepEqual(opened, []);
  }
});

test("rejects a call when there is no window", async () => {
  let handler;
  registerComposioLink({ ipcMain: { handle: (_channel, fn) => { handler = fn; } }, openExternal: async () => assert.fail("opened"), getWindow: () => null, getOrigin: () => origin });
  await assert.rejects(handler({ sender: {} }, valid));
});
