const assert = require("node:assert/strict");
const test = require("node:test");
const { registerHostedWorkspace } = require("../src/hosted-workspace-ipc");

function setup(controller) {
  let handler;
  const contents = { getURL: () => "http://127.0.0.1:4000/settings/account/" };
  registerHostedWorkspace({
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    getController: () => controller,
    getWindow: () => ({ webContents: contents }),
    getOrigin: () => "http://127.0.0.1:4000",
  });
  return { call: (action, sender = contents) => handler({ sender }, action), contents };
}

test("reports unavailable while the feature is off", async () => {
  const { call } = setup(null);
  assert.deepEqual(await call("status"), { available: false, signedIn: false, active: false });
  assert.equal((await call("open")).available, false);
});

test("passes only status and open to the controller", async () => {
  const seen = [];
  const { call } = setup({ status: () => (seen.push("status"), { available: true }), open: () => (seen.push("open"), { available: true }) });
  await call("status"); await call("open");
  assert.deepEqual(seen, ["status", "open"]);
  await assert.rejects(call("signOut"), /Unknown/);
});

test("refuses any sender that is not the local app page", async () => {
  const { call } = setup({ status: () => ({}), open: () => ({}) });
  await assert.rejects(call("open", { getURL: () => "https://suparagent.ai/app" }), /only be opened/);
});
