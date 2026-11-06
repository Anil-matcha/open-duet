// The hosted workspace view (BL-143): the account's cloud workspace shown inside
// the one desktop window, next to the local workspace.
//
// The hosted page is a remote web surface. It gets no preload, no Node, no launch
// token and no IPC; its own persistent session partition keeps its cookies apart
// from the local app. The origin is fixed here, never taken from a renderer, and
// the desktop account token is never sent to it (the owner signs in on the page).

const fs = require("node:fs");
const path = require("node:path");
const { safeExternalUrl } = require("./external-links");

const HOSTED_ORIGIN = "https://suparagent.ai";
const HOSTED_URL = `${HOSTED_ORIGIN}/app`;
const HOSTED_PARTITION = "persist:hosted";
const PLAN_URL = `${HOSTED_ORIGIN}/pricing`;
const WORKSPACES = Object.freeze(["local", "hosted"]);
const ERR_ABORTED = -3;

function hostedWebPreferences() {
  return { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false };
}

// A top-level navigation may stay on the hosted origin over HTTPS and nowhere else.
function isHostedUrl(raw, origin = HOSTED_ORIGIN) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizeWorkspace(value) {
  return WORKSPACES.includes(value) ? value : "local";
}

// The last workspace shown, so the app reopens where the owner left it. Local is the default.
function createWorkspaceStore(file) {
  return {
    read() {
      try {
        return normalizeWorkspace(JSON.parse(fs.readFileSync(file, "utf8")).last);
      } catch {
        return "local";
      }
    },
    write(last) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ last: normalizeWorkspace(last) }), { mode: 0o600 });
      } catch {
        // Remembering the choice is a convenience; never block switching.
      }
    },
  };
}

// Retry delays while the hosted view is visible: 2, 4, 8, 16 s, five tries, then a 30 s cooldown,
// with up to 20 percent jitter. Nothing retries while the view is hidden.
function retryDelay(attempt, random = Math.random) {
  const base = attempt < 4 ? 2000 * 2 ** attempt : 30000;
  return Math.round(base * (1 + 0.2 * random()));
}

// What the menu shows beside the hosted entry, from the cloud's side-effect-free status answer.
const STATUS_LABELS = {
  ready: "", waking: "waking", stopped: "sleeping", sleeping: "sleeping", provisioning: "starting",
  plan_required: "plan required", usage_limit: "usage limit reached", plan_ended: "plan ended",
  needs_provider: "provider needed", provider_limit: "busy", error: "problem",
};
function statusLabel(availability) {
  if (typeof availability !== "string") return "";
  return Object.hasOwn(STATUS_LABELS, availability) ? STATUS_LABELS[availability] : "problem";
}
const STATUS_PATH = "/api/v1/accounts/sandbox/status";
const STATUS_INTERVAL_MS = 60_000;

function failurePage(detail) {
  const safe = String(detail ?? "").replace(/[^\w .:()-]/g, "").slice(0, 120);
  const html = `<!doctype html><meta charset="utf-8"><title>Hosted workspace</title>
<body style="font:15px system-ui;margin:15vh auto;max-width:28rem;color:#222">
<h2>Hosted workspace is not reachable</h2>
<p>Check your connection. Your local workspace is unchanged. This view retries on its own while it is open.</p>
<p style="color:#777">${safe}</p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// Owns the hosted view inside `window`. `window.webContents` stays the local view.
function createHostedWorkspace({ window, WebContentsView, session, openExternal, store, onChange = () => {}, onStatus = () => {}, timers = { setTimeout, clearTimeout } }) {
  let view = null;
  let current = "local";
  let attempt = 0;
  let retryTimer = null;
  let statusTimer = null;

  // Status is read only while the hosted view is visible, never starts anything, and never runs in the background.
  const stopStatus = () => {
    if (statusTimer) timers.clearTimeout(statusTimer);
    statusTimer = null;
  };
  const pollStatus = async () => {
    stopStatus();
    if (current !== "hosted" || !view) return;
    try {
      const response = await session.fromPartition(HOSTED_PARTITION).fetch(`${HOSTED_ORIGIN}${STATUS_PATH}`, { headers: { accept: "application/json" } });
      onStatus(response.ok ? statusLabel((await response.json())?.availability) : response.status === 401 ? "sign in needed" : "");
    } catch {
      onStatus("offline");
    }
    if (current !== "hosted" || !view) return;
    statusTimer = timers.setTimeout(() => void pollStatus(), STATUS_INTERVAL_MS);
    statusTimer.unref?.();
  };

  const fit = () => {
    if (!view || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };

  const clearRetry = () => {
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    clearRetry();
    if (current !== "hosted" || !view) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (current !== "hosted" || !view || view.webContents.isDestroyed()) return;
      attempt += 1;
      void view.webContents.loadURL(HOSTED_URL).catch(() => {});
    }, retryDelay(attempt));
    retryTimer.unref?.();
  };

  function ensureView() {
    if (view) return view;
    const hostedSession = session.fromPartition(HOSTED_PARTITION);
    // Deny every permission request by default; the hosted page asks for none yet.
    hostedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    hostedSession.setPermissionCheckHandler?.(() => false);
    view = new WebContentsView({ webPreferences: { ...hostedWebPreferences(), session: hostedSession } });
    const contents = view.webContents;
    const guard = (event, url) => {
      if (!isHostedUrl(url)) {
        event.preventDefault();
        const safe = safeExternalUrl(url);
        if (safe && event.type !== "will-redirect") void Promise.resolve(openExternal(safe)).catch(() => {});
      }
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-frame-navigate", (event) => {
      if (!isHostedUrl(event.url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      const safe = safeExternalUrl(url);
      if (safe) void Promise.resolve(openExternal(safe)).catch(() => {});
      return { action: "deny" };
    });
    contents.on("did-finish-load", () => {
      if (isHostedUrl(contents.getURL())) attempt = 0;
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      void contents.loadURL(failurePage(description)).catch(() => {});
      scheduleRetry();
    });
    contents.on("render-process-gone", () => {
      if (current === "hosted" && !contents.isDestroyed()) void contents.loadURL(HOSTED_URL).catch(() => {});
    });
    window.contentView.addChildView(view);
    window.on("resize", fit);
    view.setVisible(false);
    fit();
    return view;
  }

  function show(workspace) {
    const next = normalizeWorkspace(workspace);
    if (next === current && (next === "local" || view)) return current;
    if (next === "hosted") {
      const first = !view;
      ensureView();
      current = "hosted";
      view.setVisible(true);
      fit();
      view.webContents.focus();
      if (first) void view.webContents.loadURL(HOSTED_URL).catch(() => {});
      void pollStatus();
    } else {
      current = "local";
      stopStatus();
      onStatus("");
      clearRetry();
      attempt = 0;
      view?.setVisible(false);
      window.webContents.focus();
    }
    store?.write(current);
    onChange(current);
    return current;
  }

  // Signs out of the hosted site only; the local profile and desktop account are untouched.
  async function signOut() {
    const hostedSession = session.fromPartition(HOSTED_PARTITION);
    await hostedSession.clearStorageData();
    await hostedSession.clearCache();
    if (view && !view.webContents.isDestroyed() && current === "hosted") {
      void view.webContents.loadURL(HOSTED_URL).catch(() => {});
    }
  }

  function destroy() {
    clearRetry();
    stopStatus();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = null;
  }

  return { show, signOut, destroy, current: () => current, hostedContents: () => view?.webContents ?? null };
}

module.exports = {
  HOSTED_ORIGIN, HOSTED_URL, HOSTED_PARTITION, PLAN_URL, WORKSPACES,
  hostedWebPreferences, isHostedUrl, normalizeWorkspace, createWorkspaceStore, retryDelay, failurePage, statusLabel, createHostedWorkspace,
};
