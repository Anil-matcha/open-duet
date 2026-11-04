// Sandboxed preload: one narrow native dialog capability, no Node or token.
const { contextBridge, ipcRenderer } = require("electron");

const SETTINGS_NAVIGATION_CHANNEL = "open-dots:navigate-settings";
const SETTINGS_ROUTE = "/settings/";
const settingsListeners = new Set();
let pendingSettingsNavigation = false;

function isTrustedSettingsNavigation(event, route) {
  if (route !== SETTINGS_ROUTE) return false;
  const senderUrl = event?.senderFrame?.url;
  if (typeof senderUrl !== "string" || window.location.origin === "null") return false;
  try {
    return new URL(senderUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

ipcRenderer.on(SETTINGS_NAVIGATION_CHANNEL, (event, route) => {
  if (!isTrustedSettingsNavigation(event, route)) return;
  if (settingsListeners.size === 0) {
    pendingSettingsNavigation = true;
    return;
  }
  for (const listener of settingsListeners) listener();
});

contextBridge.exposeInMainWorld("openDots", {
  desktopPermissions: (action) => ipcRenderer.invoke("open-dots:desktop-permissions", action),
  choosePath: (kind) => ipcRenderer.invoke("open-dots:choose-path", kind),
  openEngineSignIn: (url) => ipcRenderer.invoke("open-dots:engine-sign-in", url),
  openGoogleSignIn: (url) => ipcRenderer.invoke("open-dots:google-sign-in", url),
  openComposioLink: (url) => ipcRenderer.invoke("open-dots:open-composio-link", url),
  nativeControl: (request) => ipcRenderer.invoke("open-dots:native-control", request),
  copyText: (text) => ipcRenderer.invoke("open-dots:copy-text", text),
  showNotification: (payload) => ipcRenderer.invoke("open-dots:show-notification", payload),
  onSettingsRequested: (listener) => {
    if (typeof listener !== "function") throw new TypeError("A settings navigation listener is required.");
    settingsListeners.add(listener);
    if (pendingSettingsNavigation) {
      pendingSettingsNavigation = false;
      listener();
    }
    return () => settingsListeners.delete(listener);
  },
  updates: {
    run: (action) => ipcRenderer.invoke("open-dots:update", action),
    onState: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("open-dots:update-state", handler);
      return () => ipcRenderer.removeListener("open-dots:update-state", handler);
    },
  },
});
