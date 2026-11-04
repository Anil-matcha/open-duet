const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SETTINGS_NAVIGATION_CHANNEL,
  SETTINGS_ROUTE,
  createApplicationMenuTemplate,
  registerApplicationMenu,
  sendSettingsNavigation,
} = require("../src/application-menu");

function findItem(items, predicate) {
  for (const item of items) {
    if (predicate(item)) return item;
    const nested = Array.isArray(item.submenu) && findItem(item.submenu, predicate);
    if (nested) return nested;
  }
  return null;
}

test("macOS menu puts Settings in the application menu with the Command accelerator", () => {
  const onOpenSettings = () => {};
  const template = createApplicationMenuTemplate({ platform: "darwin", appName: "Open Dots", onOpenSettings });
  const settings = findItem(template, (item) => item.label === "Settings...");
  const appMenu = template[0];

  assert.equal(appMenu.label, "Open Dots");
  assert.deepEqual(appMenu.submenu.map((item) => item.role ?? item.label ?? item.type), [
    "about", "separator", "Settings...", "separator", "services", "separator",
    "hide", "hideOthers", "unhide", "separator", "quit",
  ]);
  assert.equal(settings.accelerator, "Command+,");
  assert.equal(settings.click, onOpenSettings);
});

test("Windows and Linux menus include Settings and keep edit, reload, developer tools, and window roles", () => {
  for (const platform of ["win32", "linux"]) {
    const template = createApplicationMenuTemplate({ platform });
    assert.equal(template[0].label, "File");
    const settings = findItem(template, (item) => item.label === "Settings");
    assert.equal(settings.accelerator, "Control+,");

    const editRoles = template.find((item) => item.label === "Edit").submenu.map((item) => item.role ?? item.type);
    assert.deepEqual(editRoles, ["undo", "redo", "separator", "cut", "copy", "paste", "delete", "separator", "selectAll"]);
    assert.equal(findItem(template, (item) => item.role === "reload").role, "reload");
    assert.equal(findItem(template, (item) => item.role === "forceReload").role, "forceReload");
    assert.equal(findItem(template, (item) => item.role === "toggleDevTools").role, "toggleDevTools");
    assert.equal(findItem(template, (item) => item.role === "minimize").role, "minimize");
  }
});

test("the Settings menu action sends only the validated settings route to the app window", () => {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4567/chat/",
      send: (...args) => sent.push(args),
    },
  };

  assert.equal(sendSettingsNavigation({ getWindow: () => window, getOrigin: () => "http://127.0.0.1:4567" }), true);
  assert.deepEqual(sent, [[SETTINGS_NAVIGATION_CHANNEL, SETTINGS_ROUTE]]);
  assert.equal(sendSettingsNavigation({ getWindow: () => window, getOrigin: () => "http://127.0.0.1:7654" }), false);
  assert.equal(sendSettingsNavigation({ getWindow: () => null, getOrigin: () => "http://127.0.0.1:4567" }), false);
});

test("the menu accelerator does not navigate during IME composition", () => {
  let template;
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:4567/chat/",
      send: (...args) => sent.push(args),
    },
  };
  const Menu = {
    buildFromTemplate: (given) => { template = given; return given; },
    setApplicationMenu: () => {},
  };

  registerApplicationMenu({ Menu, platform: "darwin", getWindow: () => window, getOrigin: () => "http://127.0.0.1:4567" });
  const settings = findItem(template, (item) => item.label === "Settings...");
  settings.click(null, null, { isComposing: true, keyCode: 229 });
  assert.deepEqual(sent, []);
  settings.click(null, null, { isComposing: false, keyCode: 0 });
  assert.deepEqual(sent, [[SETTINGS_NAVIGATION_CHANNEL, SETTINGS_ROUTE]]);
});
