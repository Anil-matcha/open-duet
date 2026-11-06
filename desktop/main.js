// The Open Duet desktop shell, run from a source checkout (D-012) or installed.
//
// Order of events: take the single-instance lock, show a window straight away,
// get the encryption key from the operating system's secret storage, start the
// backend and give it the launch token, and only when the backend has proved
// itself (its ready line carries an HMAC made with the token) load its address.
// The token reaches the backend over its stdin and the backend's address over
// the session's request headers; the page itself never sees it.
//
// Everything that can be tested without Electron is in src/. This file only
// connects those pieces to Electron.

const { app, BrowserWindow, WebContentsView, Menu, dialog, safeStorage, session, ipcMain, shell, systemPreferences, clipboard, Notification, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { layout, packagedLayout } = require("./src/paths");
const { createKeyStore, KeyStoreError } = require("./src/keystore");
const { startBackend, backendEnvironment, newToken } = require("./src/backend");
const { attachTokenTo, lockDown, sameOrigin } = require("./src/origin");
const { registerExternalLinks } = require("./src/external-links");
const { registerPathPicker } = require("./src/path-picker");
const { registerDesktopPermissions } = require("./src/desktop-permissions");
const { registerGoogleSignIn } = require("./src/google-sign-in");
const { registerEngineSignIn } = require("./src/engine-sign-in");
const { registerComposioLink } = require("./src/composio-link");
const { lastReason, describeFailure, describeUnexpectedExit } = require("./src/messages");
const { NativeControl, registerNativeControl } = require("./src/native-control");
const { createUpdater } = require("./src/updater");
const { registerUpdates } = require("./src/updates-ipc");
const { registerApplicationMenu } = require("./src/application-menu");
const { createHostedWorkspace, createWorkspaceStore, PLAN_URL } = require("./src/hosted-workspace");
const { HEADER } = require("./src/origin");

const mode = process.argv.includes("--mode=dev") ? "dev" : "start";
// Running from source: use the app icon for the window and the dock. Installers carry the icon in the
// executable (build/icon.icns and build/icon.ico), and build/ is not packed, so this is a no-op there.
const iconPath = path.join(__dirname, "build", "icon.png");
const hasIcon = fs.existsSync(iconPath);
// An installed app carries its own frozen backend and page; a checkout uses its own folders.
const paths = app.isPackaged ? packagedLayout(process.resourcesPath) : layout();

// Where this launch keeps its data. `dev` has its own, so developing never touches
// the data of the app that is used for real. OPEN_DOTS_DATA_DIR is a launcher
// variable (not a backend setting) for tests and for keeping a second copy apart.
function chooseUserData() {
  const given = (process.env.OPEN_DOTS_DATA_DIR ?? "").trim();
  if (given) {
    if (!path.isAbsolute(given)) throw new Error("OPEN_DOTS_DATA_DIR must be a full path.");
    return given;
  }
  // The folder keeps the name from before the rename to Open Duet: it holds the
  // database and the encrypted key, and the key store is tied to the app name.
  return path.join(app.getPath("appData"), mode === "dev" ? "Open Dots (dev)" : "Open Dots");
}

let window = null;
let backend = null;
let quitting = false;
let backendStopped = false;
let shutdown = null;
let backendOrigin = null;
let nativeControl = null;
let updater = null;

// Stops what this launch started, once: this app's own connections first (the
// backend waits for its connected clients, and idle keep-alive sockets held here
// would hold it up), then the backend. Safe to call again and again.
function stopEverything() {
  shutdown ??= (async () => {
    quitting = true;
    await nativeControl?.close();
    try {
      await session.defaultSession?.closeAllConnections?.();
    } catch {
      /* nothing left to close */
    }
    if (backend && !backendStopped) {
      try {
        await backend.stop();
      } finally {
        backendStopped = true;
      }
    }
  })();
  return shutdown;
}

// Leave once everything is stopped. `app.exit` ends the process directly: a
// second `app.quit()` after a cancelled quit is not reliable.
function leave() {
  return stopEverything().then(() => app.exit(process.exitCode ?? 0));
}

function fatal({ title, body }) {
  quitting = true;
  process.exitCode = 1;
  dialog.showErrorBox(title, body);
  return leave();
}

function createWindow() {
  const created = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 480,
    title: mode === "dev" ? "Open Duet (dev)" : "Open Duet",
    backgroundColor: "#ffffff",
    ...(hasIcon ? { icon: iconPath } : {}),
    webPreferences: {
      // The sandboxed preload exposes only the validated native path picker.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The window keeps the app's name; the page's own <title> is for browser tabs.
  created.on("page-title-updated", (event) => event.preventDefault());
  created.loadFile(path.join(__dirname, "splash.html"));
  return created;
}

function claudePathFromEnvironment() {
  const given = (process.env.OPEN_DOTS_CLAUDE_PATH ?? "").trim();
  if (given && !path.isAbsolute(given)) {
    throw new Error("OPEN_DOTS_CLAUDE_PATH must be the full path of the claude executable.");
  }
  return given;
}

async function main() {
  const userData = chooseUserData();
  // Same stored identity as the data folder above; the window title says Open Duet.
  app.setName(mode === "dev" ? "Open Dots (dev)" : "Open Dots");
  app.setPath("userData", userData);

  if (process.platform === "win32") {
    app.setAppUserModelId(app.isPackaged ? "app.opendots.desktop" : process.execPath);
  }

  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  await app.whenReady();
  registerApplicationMenu({
    Menu,
    appName: app.getName(),
    platform: process.platform,
    getWindow: () => window,
    getOrigin: () => backendOrigin,
  });
  if (hasIcon && process.platform === "darwin" && app.dock) app.dock.setIcon(iconPath);
  const nativeControlRoot = app.isPackaged ? path.join(process.resourcesPath, "native-control") : path.join(__dirname, "native-control");
  nativeControl = new NativeControl({
    root: nativeControlRoot,
    pin: require("./src/native-control-pin.json"),
    userData,
    available: fs.existsSync(path.join(nativeControlRoot, "manifest.json")),
    permissions: (prompt) => process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(prompt) && systemPreferences.getMediaAccessStatus("screen") === "granted",
  });
  registerNativeControl({ ipcMain, dialog, service: nativeControl, getWindow: () => window, getOrigin: () => backendOrigin });
  const nativeConnection = await nativeControl.listen();
  registerDesktopPermissions({ ipcMain, systemPreferences, openExternal: url => shell.openExternal(url), getWindow: () => window, getOrigin: () => backendOrigin });
  registerPathPicker({ ipcMain, dialog, getWindow: () => window, getOrigin: () => backendOrigin });
  registerEngineSignIn({ ipcMain, openExternal: url => shell.openExternal(url), getWindow: () => window, getOrigin: () => backendOrigin });
  registerGoogleSignIn({ ipcMain, openExternal: (url) => shell.openExternal(url), getWindow: () => window, getOrigin: () => backendOrigin });
  registerComposioLink({ ipcMain, openExternal: (url) => shell.openExternal(url), getWindow: () => window, getOrigin: () => backendOrigin });
  ipcMain.handle("open-dots:copy-text", (_event, text) => {
    if (typeof text === "string") {
      clipboard.writeText(text);
      return true;
    }
    return false;
  });
  ipcMain.handle("open-dots:show-notification", (_event, payload) => {
    if (!payload || typeof payload.title !== "string") return false;
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: payload.title,
        body: typeof payload.body === "string" ? payload.body : "",
        silent: payload.silent === true,
        icon: hasIcon ? iconPath : undefined,
      });
      notif.on("click", () => {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          if (payload.thread_id != null) {
            window.webContents.send("open-dots:notification-clicked", { thread_id: payload.thread_id });
          }
        }
      });
      try {
        notif.show();
        return true;
      } catch (err) {
        console.error("desktop notification show failed:", err);
        return false;
      }
    }
    return false;
  });
  updater = createUpdater({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    cacheDir: path.join(userData, "updates"),
    downloadsDir: app.getPath("downloads"),
    openFile: (file) => shell.openPath(file),
    onState: (state) => {
      if (window && !window.isDestroyed()) window.webContents.send("open-dots:update-state", state);
    },
  });
  registerUpdates({
    ipcMain,
    openExternal: (url) => shell.openExternal(url),
    updater,
    getWindow: () => window,
    getOrigin: () => backendOrigin,
  });
  window = createWindow();
  window.on("closed", () => {
    window = null;
  });

  const dataDir = path.join(userData, "data");
  const logFile = path.join(userData, "logs", "backend.log");

  let key;
  try {
    key = createKeyStore({ dir: path.join(userData, "secrets"), safeStorage }).ensure().key;
  } catch (error) {
    if (error instanceof KeyStoreError) {
      return fatal({ title: "Open Duet cannot keep its encryption key", body: error.message });
    }
    throw error;
  }

  let claudePath;
  try {
    claudePath = claudePathFromEnvironment();
  } catch (error) {
    return fatal({ title: "Open Duet cannot start", body: error.message });
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = newToken();
  backend = startBackend({
    python: paths.python,
    script: paths.backendScript,
    cwd: dataDir,
    env: backendEnvironment(process.env),
    message: {
      token,
      encryption_key: key,
      data_dir: dataDir,
      ui_dir: paths.ui,
      native_control: nativeConnection,
      ...(claudePath ? { claude_cli_path: claudePath } : {}),
    },
    token,
    logFile,
  });
  key = undefined; // the backend has it; nothing here needs it again

  let started;
  try {
    started = await backend.ready;
  } catch (failure) {
    // The window was closed while the backend was starting: that is a quit, not a failure.
    if (quitting) return;
    const code = failure.kind === "exit" ? failure.code : null;
    // A backend that could not be run wrote nothing, so the launcher's error is the reason.
    const reason = failure.kind === "spawn" ? failure.message : lastReason(logFile);
    const description = describeFailure({ code, logFile, reason, kind: failure.kind });
    if (failure.kind === "timeout") {
      description.body = `The backend did not become ready in time.\n\n${description.body}`;
    }
    backendStopped = true;
    return fatal(description);
  }

  backend.exited.then(({ code }) => {
    backendStopped = true;
    if (!quitting) fatal(describeUnexpectedExit({ code, logFile, reason: lastReason(logFile) }));
  });

  if (!window) return; // closed while the backend was starting
  backendOrigin = started.origin;
  attachTokenTo(window.webContents.session, started.origin, token);
  lockDown(window.webContents, started.origin, window.webContents.session);
  registerExternalLinks(window.webContents, {
    Menu,
    clipboard,
    openExternal: (url) => shell.openExternal(url),
    getWindow: () => window,
  });
  try {
    await window.loadURL(`${started.origin}/chat/`);
  } catch (error) {
    // Closing the window while the page loads aborts the load: not an error to report.
    // A same-origin navigation (for example opening Settings) can also replace
    // the initial load. It must not open a fatal, blocking startup dialog.
    const replaced = error?.code === "ERR_ABORTED" && window && sameOrigin(window.webContents.getURL(), started.origin);
    if (!quitting && !replaced) throw error;
  }
  setUpWorkspaces(token);
  startUpdateChecks();
}

// Local and hosted workspaces share this one window (BL-143). The local page stays the window's own
// contents; the hosted page is a separate sandboxed view with no preload, no token and its own session.
function setUpWorkspaces(token) {
  // Behind a flag until staging and packaged checks pass (plan step 7). Off means no hosted view and no menu.
  if (process.env.OPEN_DOTS_HOSTED_WORKSPACE !== "1") return;
  const win = window;
  const store = createWorkspaceStore(path.join(app.getPath("userData"), "workspace.json"));
  const state = { signedIn: false, email: null, status: "" };
  let hosted = null;
  const renderMenu = () =>
    registerApplicationMenu({
      Menu,
      appName: app.getName(),
      platform: process.platform,
      getWindow: () => window,
      getOrigin: () => backendOrigin,
      workspace: {
        active: hosted?.current() ?? "local",
        signedIn: state.signedIn,
        email: state.email,
        status: state.status,
        onSelect: async (which) => {
          // Re-ask the backend at the moment of choosing, so a sign-in made after the last check counts.
          if (which === "hosted" && !state.signedIn) await refresh(true);
          if (which === "hosted" && !state.signedIn) {
            void shell.openExternal(PLAN_URL);
            renderMenu(); // put the radio back on the workspace that is still shown
            return;
          }
          hosted.show(which);
        },
        onSignOut: () => void hosted.signOut(),
      },
    });
  hosted = createHostedWorkspace({
    window: win,
    WebContentsView,
    session,
    openExternal: (url) => shell.openExternal(url),
    store,
    // The title says which data is on screen: native chrome the hosted page cannot read or draw.
    onChange: (which) => {
      win.setTitle(which === "hosted" ? "Open Duet \u2014 Hosted workspace (cloud data; local agents are not shown here)" : mode === "dev" ? "Open Duet (dev)" : "Open Duet");
      renderMenu();
    },
    onStatus: (status) => {
      if (status === state.status) return;
      state.status = status;
      renderMenu();
    },
  });
  win.on("closed", () => hosted.destroy());

  // Account state comes from the local backend with the launch token; the hosted page never sees either.
  let lastRefresh = 0;
  const refresh = async (force = false) => {
    if (!force && Date.now() - lastRefresh < 60_000) return;
    lastRefresh = Date.now();
    try {
      const response = await net.fetch(`${backendOrigin}/api/v1/desktop-account/status`, { headers: { [HEADER]: token } });
      const body = response.ok ? await response.json() : null;
      if (!response.ok) console.error("hosted workspace: account status returned", response.status);
      const signedIn = body?.signed_in === true;
      const email = signedIn && typeof body.email === "string" ? body.email : null;
      if (signedIn !== state.signedIn || email !== state.email) {
        state.signedIn = signedIn;
        state.email = email;
        renderMenu();
      }
    } catch (error) {
      // Offline or unavailable: keep the last known state.
      console.error("hosted workspace: account status check failed:", error?.message ?? error);
    }
  };
  win.on("focus", () => void refresh());
  renderMenu();
  void refresh().then(() => {
    if (state.signedIn && store.read() === "hosted") hosted.show("hosted");
  });
}

// Background checks only run in an installed app, and can be switched off.
function startUpdateChecks() {
  if (!app.isPackaged || process.env.OPEN_DOTS_DISABLE_UPDATE_CHECK === "1") return;
  setTimeout(() => void updater?.check(), 15_000).unref();
  setInterval(() => void updater?.check(), 6 * 60 * 60 * 1000).unref();
}

app.on("window-all-closed", () => {
  leave();
});

// A quit that comes from anywhere else (the system, a menu, DevTools): stop the
// backend, then go.
app.on("before-quit", (event) => {
  quitting = true;
  if (!backend || backendStopped) return;
  event.preventDefault();
  leave();
});

main().catch((error) => {
  if (!quitting) fatal({ title: "Open Duet could not start", body: String(error?.stack ?? error) });
});
