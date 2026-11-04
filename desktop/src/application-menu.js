const { sameOrigin } = require("./origin");

const SETTINGS_NAVIGATION_CHANNEL = "open-dots:navigate-settings";
const SETTINGS_ROUTE = "/settings/";

function createApplicationMenuTemplate({ platform, appName = "Open Dots", onOpenSettings = () => {} }) {
  const isMac = platform === "darwin";
  const settings = {
    label: isMac ? "Settings..." : "Settings",
    accelerator: isMac ? "Command+," : "Control+,",
    click: onOpenSettings,
  };
  const edit = {
    label: "Edit",
    role: "editMenu",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };
  const view = {
    label: "View",
    role: "viewMenu",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { role: "togglefullscreen" },
    ],
  };
  const windowMenu = {
    label: "Window",
    role: "windowMenu",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { role: "front" },
      { role: "close" },
    ],
  };
  const help = isMac
    ? { role: "help" }
    : { label: "Help", submenu: [{ label: `About ${appName}`, role: "about" }] };

  if (isMac) {
    return [
      {
        label: appName,
        submenu: [
          { role: "about" },
          { type: "separator" },
          settings,
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      edit,
      view,
      windowMenu,
      help,
    ];
  }

  return [
    {
      label: "File",
      submenu: [settings, { type: "separator" }, { role: "quit" }],
    },
    edit,
    view,
    windowMenu,
    help,
  ];
}

function sendSettingsNavigation({ getWindow, getOrigin }) {
  const window = getWindow();
  const origin = getOrigin();
  if (!window || window.isDestroyed() || !origin) return false;
  const contents = window.webContents;
  if (!contents || contents.isDestroyed() || !sameOrigin(contents.getURL(), origin)) return false;
  contents.send(SETTINGS_NAVIGATION_CHANNEL, SETTINGS_ROUTE);
  return true;
}

function registerApplicationMenu({ Menu, appName, getWindow, getOrigin, platform = process.platform }) {
  const template = createApplicationMenuTemplate({
    platform,
    appName,
    onOpenSettings: (_item, _window, event) => {
      if (event?.isComposing || event?.keyCode === 229) return false;
      return sendSettingsNavigation({ getWindow, getOrigin });
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return template;
}

module.exports = {
  SETTINGS_NAVIGATION_CHANNEL,
  SETTINGS_ROUTE,
  createApplicationMenuTemplate,
  sendSettingsNavigation,
  registerApplicationMenu,
};
