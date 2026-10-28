const { sameOrigin } = require("./origin");

const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen_recording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function registerDesktopPermissions({ ipcMain, systemPreferences, openExternal, getWindow, getOrigin, platform = process.platform }) {
  ipcMain.handle("open-dots:desktop-permissions", async (event, action = "status") => {
    const window = getWindow();
    const origin = getOrigin();
    if (!window || !origin || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !sameOrigin(event.senderFrame?.url, origin)) throw new Error("Open permissions from the app window.");
    const page = new URL(event.senderFrame.url).pathname.replace(/\/$/, "");
    if (!["/onboarding", "/settings"].includes(page) || !["status", ...Object.keys(PANES)].includes(action)) throw new Error("Permission action is unavailable here.");
    if (platform !== "darwin") return { supported: false, accessibility: false, screen_recording: false };
    if (action !== "status") await openExternal(PANES[action]);
    return { supported: true, accessibility: systemPreferences.isTrustedAccessibilityClient(false), screen_recording: systemPreferences.getMediaAccessStatus("screen") === "granted" };
  });
}

module.exports = { registerDesktopPermissions };
