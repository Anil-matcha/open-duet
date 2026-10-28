const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEngineSignIn, registerEngineSignIn } = require("../src/engine-sign-in");

test("engine sign-in opens only provider authorization pages", () => {
  assert.equal(validateEngineSignIn("https://auth.openai.com/codex/device"), "https://auth.openai.com/codex/device");
  assert.ok(validateEngineSignIn("https://claude.com/cai/oauth/authorize?state=one"));
  for (const link of ["https://claude.com.evil.test/oauth/authorize?x=1", "https://claude.com/other?x=1", "https://auth.openai.com/codex/device?redirect=evil", "https://user:pass@claude.com/oauth/authorize?x=1", "file:///etc/passwd", "http://claude.com/oauth/authorize?x=1", "https://claude.com:8443/oauth/authorize?x=1"]) assert.throws(() => validateEngineSignIn(link));
});

test("setup main frame can open sign-in; subframes and other pages cannot", async () => {
  const mainFrame = { url: "http://127.0.0.1:1234/onboarding/" };
  const window = { webContents: { mainFrame } };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  const opened = [];
  let handler;
  registerEngineSignIn({ ipcMain: { handle: (_, fn) => { handler = fn; } }, openExternal: async link => opened.push(link), getWindow: () => window, getOrigin: () => "http://127.0.0.1:1234" });
  await handler(event, "https://auth.openai.com/codex/device");
  assert.equal(opened.length, 1);
  await assert.rejects(handler({ ...event, senderFrame: { url: mainFrame.url } }, "https://auth.openai.com/codex/device"));
  mainFrame.url = "http://127.0.0.1:1234/chat/";
  await assert.rejects(handler(event, "https://auth.openai.com/codex/device"));
  for (const page of ["/settings/", "/settings/account/", "/apps/"]) {
    mainFrame.url = `http://127.0.0.1:1234${page}`;
    await assert.rejects(handler(event, "https://auth.openai.com/codex/device"), undefined, page);
  }
  mainFrame.url = "http://127.0.0.1:1234/settings/engines/";
  await handler(event, "https://auth.openai.com/codex/device");
  mainFrame.url = "https://evil.test/settings/engines/";
  await assert.rejects(handler(event, "https://auth.openai.com/codex/device"));
  assert.equal(opened.length, 2);
});
