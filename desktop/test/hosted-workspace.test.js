const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const H = require("../src/hosted-workspace");
const { createApplicationMenuTemplate } = require("../src/application-menu");

function fakes() {
  const opened = [];
  const handlers = {};
  const loads = [];
  const partitions = [];
  const sessionObj = { setPermissionRequestHandler(fn) { this.permission = fn; }, clearStorageData: async () => { sessionObj.cleared = true; }, clearCache: async () => {} };
  class View {
    constructor(options) {
      this.options = options;
      this.visible = null;
      this.webContents = {
        on: (name, fn) => { handlers[name] = fn; },
        setWindowOpenHandler: (fn) => { handlers.open = fn; },
        loadURL: async (url) => { loads.push(url); },
        isDestroyed: () => false, getURL: () => H.HOSTED_URL, focus() {}, close() {},
      };
    }
    setBounds(b) { this.bounds = b; }
    setVisible(v) { this.visible = v; }
  }
  const window = {
    isDestroyed: () => false, getContentSize: () => [900, 700], on() {},
    contentView: { addChildView() {} }, webContents: { focus() {} },
  };
  const written = [];
  const created = [];
  const hosted = H.createHostedWorkspace({
    window, WebContentsView: class extends View { constructor(o) { super(o); created.push(o); } },
    session: { fromPartition: (name) => { partitions.push(name); return sessionObj; } },
    openExternal: (url) => opened.push(url), store: { write: (v) => written.push(v) },
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
  });
  return { created, hosted, opened, handlers, loads, partitions, sessionObj, written };
}

test("hosted view is sandboxed with no preload, Node or token, in its own partition", () => {
  const f = fakes();
  f.hosted.show("hosted");
  assert.ok(f.partitions.length > 0 && f.partitions.every((p) => p === H.HOSTED_PARTITION));
  const webPrefs = f.created[0].webPreferences;
  assert.equal(webPrefs.session, f.sessionObj);
  assert.equal(webPrefs.sandbox, true);
  assert.equal(webPrefs.contextIsolation, true);
  assert.equal(webPrefs.nodeIntegration, false);
  assert.equal("preload" in webPrefs, false);
  assert.deepEqual(f.loads, [H.HOSTED_URL]);
});

test("only https on the hosted origin may load; everything else is blocked", () => {
  assert.equal(H.isHostedUrl("https://suparagent.ai/app/chat"), true);
  for (const bad of ["http://suparagent.ai/app", "https://evil.example/", "https://suparagent.ai.evil.example/", "https://u:p@suparagent.ai/", "file:///etc/passwd", "javascript:1", "nonsense"]) {
    assert.equal(H.isHostedUrl(bad), false, bad);
  }
});

test("navigation off the hosted origin is blocked and sent to the system browser safely", () => {
  const f = fakes();
  f.hosted.show("hosted");
  let prevented = 0;
  f.handlers["will-navigate"]({ preventDefault: () => prevented++, type: "will-navigate" }, "https://example.com/docs");
  f.handlers["will-navigate"]({ preventDefault: () => prevented++, type: "will-navigate" }, "javascript:alert(1)");
  f.handlers["will-navigate"]({ preventDefault: () => prevented++, type: "will-navigate" }, "https://suparagent.ai/app/x");
  f.handlers["will-redirect"]({ preventDefault: () => prevented++, type: "will-redirect" }, "https://example.com/r");
  assert.equal(prevented, 3);
  assert.deepEqual(f.opened, ["https://example.com/docs"]);
  assert.deepEqual(f.handlers.open({ url: "https://example.com/p" }), { action: "deny" });
  assert.deepEqual(f.handlers.open({ url: "file:///x" }), { action: "deny" });
  assert.deepEqual(f.opened, ["https://example.com/docs", "https://example.com/p"]);
});

test("permissions are denied and switching remembers the workspace", () => {
  const f = fakes();
  f.hosted.show("hosted");
  let granted = null;
  f.sessionObj.permission(null, "media", (v) => { granted = v; });
  assert.equal(granted, false);
  f.hosted.show("local");
  assert.deepEqual(f.written, ["hosted", "local"]);
  assert.equal(f.hosted.current(), "local");
  f.hosted.show("hosted");
  assert.equal(f.loads.length, 1, "reopening does not reload or wake anything");
});

test("hosted sign-out clears only the hosted partition", async () => {
  const f = fakes();
  await f.hosted.signOut();
  assert.equal(f.sessionObj.cleared, true);
  assert.ok(f.partitions.length > 0 && f.partitions.every((p) => p === H.HOSTED_PARTITION));
});

test("workspace store defaults to local and survives bad data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const store = H.createWorkspaceStore(path.join(dir, "workspace.json"));
  assert.equal(store.read(), "local");
  store.write("hosted");
  assert.equal(store.read(), "hosted");
  fs.writeFileSync(path.join(dir, "workspace.json"), "{bad");
  assert.equal(store.read(), "local");
});

test("retry backs off 2, 4, 8, 16 s then 30 s with bounded jitter", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => H.retryDelay(n, () => 0)), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(H.retryDelay(0, () => 1), 2400);
});

test("failure page never echoes markup", () => {
  assert.ok(!decodeURIComponent(H.failurePage("<script>x</script>")).includes("<script>x"));
});

test("Workspace menu has radio items and Cmd/Ctrl+1 and +2", () => {
  const picks = [];
  const workspace = { active: "hosted", signedIn: true, email: "a@b.co", onSelect: (w) => picks.push(w), onSignOut: () => picks.push("out") };
  for (const [platform, mod] of [["darwin", "Command"], ["win32", "Control"]]) {
    const menu = createApplicationMenuTemplate({ platform, workspace }).find((m) => m.label === "Workspace");
    const [local, hosted, , signOut] = menu.submenu;
    assert.equal(local.accelerator, `${mod}+1`);
    assert.equal(hosted.accelerator, `${mod}+2`);
    assert.equal(hosted.label, "Hosted workspace (a@b.co)");
    assert.equal(hosted.checked, true);
    assert.equal(local.checked, false);
    assert.equal(signOut.enabled, true);
    local.click(); hosted.click(); signOut.click();
  }
  assert.deepEqual(picks.slice(0, 3), ["local", "hosted", "out"]);
  assert.equal(createApplicationMenuTemplate({ platform: "darwin" }).some((m) => m.label === "Workspace"), false);
});

test("status labels cover known states and never echo unknown ones", () => {
  assert.equal(H.statusLabel("ready"), "");
  assert.equal(H.statusLabel("stopped"), "sleeping");
  assert.equal(H.statusLabel("plan_required"), "plan required");
  assert.equal(H.statusLabel("<script>"), "problem");
  assert.equal(H.statusLabel(undefined), "");
  const menu = createApplicationMenuTemplate({ platform: "win32", workspace: { active: "hosted", signedIn: true, email: "a@b.co", status: "sleeping", onSelect() {}, onSignOut() {} } });
  assert.equal(menu.find((m) => m.label === "Workspace").submenu[1].label, "Hosted workspace (a@b.co) · sleeping");
});

test("status is read only while hosted is visible and stops when switching away", async () => {
  const f = fakes();
  const seen = [];
  const fetched = [];
  const timers = [];
  const hosted = H.createHostedWorkspace({
    window: { isDestroyed: () => false, getContentSize: () => [1, 1], on() {}, contentView: { addChildView() {} }, webContents: { focus() {} } },
    WebContentsView: class { constructor() { this.webContents = { on() {}, setWindowOpenHandler() {}, loadURL: async () => {}, isDestroyed: () => false, focus() {} }; } setBounds() {} setVisible() {} },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => ({ availability: "stopped" }) }; } }) },
    openExternal() {}, onStatus: (s) => seen.push(s),
    timers: { setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout() {} },
  });
  hosted.show("local");
  assert.equal(fetched.length, 0, "nothing is read while local is shown");
  hosted.show("hosted");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetched, ["https://suparagent.ai/api/v1/accounts/sandbox/status"]);
  assert.deepEqual(seen, ["sleeping"]);
  hosted.show("local");
  assert.equal(seen.at(-1), "");
});
