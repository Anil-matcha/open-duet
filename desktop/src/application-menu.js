const { sameOrigin } = require("./origin");

const SETTINGS_NAVIGATION_CHANNEL = "open-dots:navigate-settings";
const SETTINGS_ROUTE = "/settings/";

// Native, so the hosted page can neither read nor draw it. Radio items show where the window is.
function workspaceMenu({ platform, workspace }) {
  const mod = platform === "darwin" ? "Command" : "Control";
  const hosted = workspace.signedIn
    ? `Hosted workspace${workspace.email ? ` (${workspace.email})` : ""}${workspace.status ? ` · ${workspace.status}` : ""}`
    : "Hosted workspace (sign in to your account)";
  return {
    label: "Workspace",
    submenu: [
      { label: "Local (this computer)", type: "radio", checked: workspace.active !== "hosted", accelerator: `${mod}+1`, click: () => workspace.onSelect("local") },
      { label: hosted, type: "radio", checked: workspace.active === "hosted", accelerator: `${mod}+2`, click: () => workspace.onSelect("hosted") },
      { type: "separator" },
      { label: "Sign out of hosted workspace", enabled: workspace.active === "hosted", click: () => workspace.onSignOut() },
    ],
  };
}

function createApplicationMenuTemplate({ platform, appName = "Open Dots", onOpenSettings = () => {}, workspace = null }) {
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
      ...(workspace ? [workspaceMenu({ platform, workspace })] : []),
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
    ...(workspace ? [workspaceMenu({ platform, workspace })] : []),
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

function registerApplicationMenu({ Menu, appName, getWindow, getOrigin, platform = process.platform, workspace = null }) {
  const template = createApplicationMenuTemplate({
    platform,
    appName,
    workspace,
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
