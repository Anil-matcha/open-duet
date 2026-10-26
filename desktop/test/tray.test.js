const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");

const { trayIconPath, trayMenuTemplate } = require("../src/tray");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-tray-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the built favicon is used as the tray icon when the UI build has one", () => {
  fs.writeFileSync(path.join(dir, "favicon.ico"), "not a real ico, just a marker");
  assert.equal(trayIconPath(dir), path.join(dir, "favicon.ico"));
});

test("no favicon in the UI build means no icon path, not a thrown error", () => {
  assert.equal(trayIconPath(dir), null);
  assert.equal(trayIconPath(path.join(dir, "does-not-exist")), null);
});

test("the menu opens the window and can quit, and names the app", () => {
  let opened = 0;
  let quit = 0;
  const template = trayMenuTemplate({
    appName: "Open Duet (dev)",
    onOpen: () => opened++,
    onQuit: () => quit++,
  });

  assert.equal(template.length, 3);
  assert.equal(template[0].label, "Open Open Duet (dev)");
  assert.equal(template[1].type, "separator");
  assert.equal(template[2].label, "Quit Open Duet (dev)");

  template[0].click();
  template[2].click();
  assert.equal(opened, 1);
  assert.equal(quit, 1);
});
