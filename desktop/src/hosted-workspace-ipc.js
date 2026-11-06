const { sameOrigin } = require("./origin");

// The Settings page asks whether the hosted workspace is offered and may ask the shell to show it.
// Only the local app page may ask; the hosted view has no preload and no way to reach this.
// `controller` is null while the feature is off, so the page then sees "unavailable".
function registerHostedWorkspace({ ipcMain, getController, getWindow, getOrigin }) {
  ipcMain.handle("open-dots:hosted-workspace", async (event, action) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || !sameOrigin(window.webContents.getURL(), getOrigin())) {
      throw new Error("The hosted workspace can only be opened from the Open Duet app.");
    }
    const controller = getController();
    if (!controller) return { available: false, signedIn: false, active: false };
    if (action === "open") return controller.open();
    if (action === "status") return controller.status();
    throw new Error("Unknown hosted workspace action.");
  });
}

module.exports = { registerHostedWorkspace };
