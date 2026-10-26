const { sameOrigin } = require("./origin");

// The one external page Settings may open for connected apps: the connect link
// Composio hands out (https://connect.composio.dev/...). The window itself
// cannot open windows, so the shell opens it in the system browser.
function validateComposioLinkUrl(raw) {
  if (typeof raw !== "string" || raw.length > 4096 || /\s/u.test(raw)) {
    throw new Error("Invalid Composio connect link.");
  }
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Invalid Composio connect link."); }
  const host = url.hostname;
  if (
    url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !(host === "composio.dev" || host.endsWith(".composio.dev"))
  ) throw new Error("Invalid Composio connect link.");
  return url.href;
}

function registerComposioLink({ ipcMain, openExternal, getWindow, getOrigin }) {
  ipcMain.handle("open-dots:open-composio-link", async (event, raw) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || !sameOrigin(window.webContents.getURL(), getOrigin())) {
      throw new Error("Connected apps must be opened from Open Duet Settings.");
    }
    await openExternal(validateComposioLinkUrl(raw));
  });
}

module.exports = { validateComposioLinkUrl, registerComposioLink };
