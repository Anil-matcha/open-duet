// What keeps Open Duet reachable after its window is closed: a tray icon with
// a short menu. Pure and Electron-free so it can be unit tested; main.js wires
// the callbacks to the real window and app.

const fs = require("node:fs");
const path = require("node:path");

// The favicon Next.js copies into the built UI (frontend/app/favicon.ico ->
// <ui>/favicon.ico) doubles as the tray icon, so no new binary asset has to
// ship with the app. A checkout that has not been built yet, or a UI build
// without one, has no icon file: callers fall back to the platform default.
function trayIconPath(uiDir) {
  const candidate = path.join(uiDir, "favicon.ico");
  return fs.existsSync(candidate) ? candidate : null;
}

// The tray's context menu, as a plain template Electron's Menu.buildFromTemplate
// accepts directly. `label` carries the app's display name so dev and release
// builds read "Open Open Duet (dev)" / "Open Open Duet".
function trayMenuTemplate({ appName, onOpen, onQuit }) {
  return [
    { label: `Open ${appName}`, click: onOpen },
    { type: "separator" },
    { label: `Quit ${appName}`, click: onQuit },
  ];
}

module.exports = { trayIconPath, trayMenuTemplate };
