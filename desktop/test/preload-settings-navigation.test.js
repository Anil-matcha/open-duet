const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreload(origin) {
  const handlers = new Map();
  const exposed = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: {
      invoke: async () => undefined,
      on: (channel, listener) => handlers.set(channel, listener),
      removeListener: () => {},
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (name) => {
      if (name === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
    window: { location: { origin } },
    URL,
    Set,
    TypeError,
  });
  return { api: exposed.openDots, handlers };
}

test("preload accepts only same-origin settings navigation and buffers it until subscribed", () => {
  const { api, handlers } = loadPreload("http://127.0.0.1:4567");
  const dispatch = handlers.get("open-dots:navigate-settings");
  let navigations = 0;

  dispatch({ senderFrame: { url: "http://127.0.0.1:4567/chat/" } }, "/settings/profile/");
  dispatch({ senderFrame: { url: "http://127.0.0.1:7654/chat/" } }, "/settings/");
  api.onSettingsRequested(() => { navigations += 1; });
  assert.equal(navigations, 0);

  dispatch({ senderFrame: { url: "http://127.0.0.1:4567/chat/" } }, "/settings/");
  assert.equal(navigations, 1);
});

test("preload delivers a valid request received before the app subscribes", () => {
  const { api, handlers } = loadPreload("http://127.0.0.1:4567");
  handlers.get("open-dots:navigate-settings")(
    { senderFrame: { url: "http://127.0.0.1:4567/chat/" } },
    "/settings/",
  );
  let navigations = 0;

  const unsubscribe = api.onSettingsRequested(() => { navigations += 1; });
  assert.equal(navigations, 1);
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
});
