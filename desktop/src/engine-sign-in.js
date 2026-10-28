const { sameOrigin } = require("./origin");

const CLAUDE_HOSTS = new Set(["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"]);

function validateEngineSignIn(raw) {
  if (typeof raw !== "string" || raw.length > 16384 || /\s/u.test(raw)) throw new Error("Invalid engine sign-in link.");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Invalid engine sign-in link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("Invalid engine sign-in link.");
  const claude = CLAUDE_HOSTS.has(url.hostname) && /^(\/[a-z]{1,8})?\/oauth\/authorize$/.test(url.pathname) && !!url.search;
  const codex = url.href === "https://auth.openai.com/codex/device";
  if (!claude && !codex) throw new Error("Invalid engine sign-in link.");
  return url.href;
}

function registerEngineSignIn({ ipcMain, openExternal, getWindow, getOrigin }) {
  ipcMain.handle("open-dots:engine-sign-in", async (event, raw) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !sameOrigin(event.senderFrame?.url, getOrigin())) throw new Error("Start engine sign-in from the app window.");
    if (!["/settings", "/onboarding"].includes(new URL(event.senderFrame.url).pathname.replace(/\/$/, ""))) throw new Error("Start engine sign-in from Settings or setup.");
    await openExternal(validateEngineSignIn(raw));
  });
}

module.exports = { validateEngineSignIn, registerEngineSignIn };
