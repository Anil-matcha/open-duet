#!/usr/bin/env node
/* Browser smoke coverage for the static onboarding export. All API traffic is mocked. */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const STATIC_ROOT = path.join(ROOT, "frontend", "out");
const SHOTS = process.env.ONBOARDING_QA_SCREENSHOTS || path.join(require("node:os").tmpdir(), "open-dots-onboarding-qa");
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_MODULE || path.join(ROOT, "desktop", "node_modules", "@playwright", "test");
const { chromium, expect } = require(PLAYWRIGHT_PATH);

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res) {
  let requestPath;
  try { requestPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); }
  catch { res.writeHead(400).end("Bad path"); return; }
  if (requestPath === "/") requestPath = "/index.html";
  if (requestPath.endsWith("/")) requestPath += "index.html";
  let file = path.resolve(STATIC_ROOT, `.${requestPath}`);
  if (!file.startsWith(`${STATIC_ROOT}${path.sep}`) && file !== path.join(STATIC_ROOT, "index.html")) {
    res.writeHead(403).end("Forbidden"); return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Static export routes are directories. The only fallback is the exported
    // HTML file for that route; unknown assets stay 404 instead of returning HTML.
    const routeHtml = path.join(file, "index.html");
    if (fs.existsSync(routeHtml) && fs.statSync(routeHtml).isFile()) file = routeHtml;
    else { res.writeHead(404).end("Not found"); return; }
  }
  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function freshState(overrides = {}) {
  return {
    version: 1, status: "pending",
    draft: { step: 0, provider: "claude", model: null, name: "", purpose: "", first_request: "",
      create_agent: false, make_lead: false },
    agent_id: null, first_reply_at: null, execution_host: "desktop", existing_agents: false,
    ...overrides,
  };
}

function engine(id, label) {
  return {
    id, label, kind: "cli", installed: true, version: "1.0.0", signed_in: true,
    available: true, reason: null, models: [{ id: "default", label: "Default", default: true }],
    default_model: "default", custom_models: false,
    capabilities: { tools: true, approvals: true, mcp: id === "claude", images: true, resume: true, computers: false },
    configurable: false, can_write_text: true, config: null, preset: false,
    setup: { managed_install: true, install: null, sign_in: null, credential: "subscription", notes: [] },
    config_fields: [],
  };
}

function makeMockState({ desktop = false, failInitialOnboardingReads = 0 } = {}) {
  return {
    desktop, accountSignedIn: false, profileBound: false, onboarding: freshState({ execution_host: desktop ? "desktop" : "server" }),
    failInitialOnboardingReads, onboardingReads: 0, requests: [], agents: [], threads: [],
    createdThreadCount: 0, sentTurnCount: 0, authStatusCount: 0, accountStatusCount: 0,
    engineItems: [engine("claude", "Claude"), engine("codex", "Codex CLI")],
  };
}

function jsonResponse(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installApiMocks(page, state) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname.replace(/^\/api\/v1/, "") || "/";
    const method = request.method().toUpperCase();
    let body = null;
    try { if (request.postData()) body = JSON.parse(request.postData()); } catch { body = request.postData(); }
    state.requests.push({ endpoint, method, body, headers: request.headers() });

    if (endpoint === "/auth/status" && method === "GET") {
      state.authStatusCount++;
      return jsonResponse(route, 200, { owner_configured: true, setup_allowed: false, desktop: state.desktop, signed_in: state.desktop ? state.accountSignedIn : true });
    }
    if (endpoint === "/auth/session" && method === "GET") {
      return jsonResponse(route, 200, { kind: state.desktop ? "desktop" : "browser", scopes: ["admin", "chat"], label: null,
        session_id: state.desktop ? null : 1, user_id: "smoke-user", csrf_token: state.desktop ? null : "csrf-smoke", owner_configured: true });
    }
    if (endpoint === "/auth/identity" && method === "PUT") return jsonResponse(route, 200, { user_id: "smoke-user" });

    if (endpoint === "/desktop-account/status" && method === "GET") {
      state.accountStatusCount++;
      return jsonResponse(route, 200, { signed_in: state.accountSignedIn, email: state.accountSignedIn ? "owner@example.test" : null,
        account_required: true, profile_bound: state.profileBound });
    }
    if (endpoint === "/desktop-account/email/start" && method === "POST") {
      return jsonResponse(route, 200, { sent: true, expires_in: 600 });
    }
    if (endpoint === "/desktop-account/email/verify" && method === "POST") {
      if (body?.code !== "123456") return jsonResponse(route, 422, { detail: { error_code: "invalid_code", message: "The code is invalid. Try again." } });
      if (body?.adopt_local_data !== true) return jsonResponse(route, 409, { detail: { error_code: "local_data_adoption_required", message: "Confirm profile use." } });
      state.accountSignedIn = true; state.profileBound = true;
      return jsonResponse(route, 200, { signed_in: true, email: body.email, profile_bound: true });
    }

    if (endpoint === "/onboarding" && method === "GET") {
      state.onboardingReads++;
      if (state.failInitialOnboardingReads > 0) {
        state.failInitialOnboardingReads--;
        return jsonResponse(route, 503, { detail: { error_code: "smoke_read_failure", message: "Setup progress is temporarily unavailable." } });
      }
      return jsonResponse(route, 200, structuredClone(state.onboarding));
    }
    if (endpoint === "/onboarding" && method === "PUT") {
      if (body?.expected_version !== state.onboarding.version) return jsonResponse(route, 409, { detail: { error_code: "onboarding_conflict", message: "Progress changed." } });
      state.onboarding = { ...state.onboarding, version: state.onboarding.version + 1, draft: body.draft };
      return jsonResponse(route, 200, structuredClone(state.onboarding));
    }
    if (endpoint === "/onboarding/complete" && method === "POST") {
      if (body?.expected_version !== state.onboarding.version) return jsonResponse(route, 409, { detail: { error_code: "onboarding_conflict", message: "Progress changed." } });
      state.onboarding = { ...state.onboarding, version: state.onboarding.version + 1, status: "configured", draft: body.draft,
        agent_id: body.draft.create_agent ? 501 : null };
      if (body.draft.create_agent) state.agents = [makeAgent(501, body.draft)];
      return jsonResponse(route, 200, structuredClone(state.onboarding));
    }
    if (endpoint === "/onboarding/skip" && method === "POST") {
      state.onboarding = { ...state.onboarding, version: state.onboarding.version + 1, status: "skipped" };
      return jsonResponse(route, 200, structuredClone(state.onboarding));
    }
    if (endpoint === "/onboarding/restart" && method === "POST") {
      state.onboarding = freshState({ version: state.onboarding.version + 1, execution_host: state.desktop ? "desktop" : "server", existing_agents: state.agents.length > 0 });
      return jsonResponse(route, 200, structuredClone(state.onboarding));
    }

    if (endpoint === "/engines" && method === "GET") return jsonResponse(route, 200, state.engineItems);
    if (endpoint.startsWith("/engines/") && method === "GET") {
      const id = endpoint.split("/")[2];
      return jsonResponse(route, 200, state.engineItems.find((item) => item.id === id) || state.engineItems[0]);
    }
    if (endpoint === "/local/status") return jsonResponse(route, 200, { enabled: true, available: true, reason: null, cli_version: "1.0.0", tools_enabled: true });
    if (endpoint === "/needs-you/presence") return jsonResponse(route, 200, { returned: false, first_today: false, open: null });
    if (endpoint === "/threads" && method === "GET") return jsonResponse(route, 200, state.threads);
    if (endpoint === "/threads" && method === "POST") {
      state.createdThreadCount++;
      const created = { id: 900 + state.createdThreadCount, agent_id: body?.agent_id ?? null, title: null,
        provider: body?.provider || "claude", model: body?.model ?? null, session_state: "new", last_seq: 0,
        archived_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      state.threads.unshift(created);
      return jsonResponse(route, 201, created);
    }
    if (/^\/threads\/\d+\/turns$/.test(endpoint) && method === "POST") {
      state.sentTurnCount++;
      return jsonResponse(route, 202, { id: 1, seq: 1, prompt_text: body?.prompt_text || "", status: "running", error_code: null,
        error: null, result: null, model: null, usage: null, started_at: new Date().toISOString(), finished_at: null });
    }
    if (endpoint === "/agents" && method === "GET") return jsonResponse(route, 200, state.agents);
    if (endpoint.match(/^\/agents\/\d+\/skills$/) && method === "GET") return jsonResponse(route, 200, []);
    if (endpoint === "/team" && method === "GET") return jsonResponse(route, 200, { enabled: true, team: { id: 1, name: "My team", lead_agent_id: null }, agents: [], limits: {}, lead_ready: { ok: true } });
    if (endpoint === "/team/jobs" && method === "GET") return jsonResponse(route, 200, []);
    if (endpoint === "/rooms" && method === "GET") return jsonResponse(route, 200, []);
    if (endpoint === "/notifications/unread" && method === "GET") return jsonResponse(route, 200, { unread: 0 });
    if (endpoint === "/notifications" && method === "GET") return jsonResponse(route, 200, []);
    if (endpoint === "/templates" && method === "GET") return jsonResponse(route, 200, { items: [] });
    if (endpoint === "/routines" && method === "GET") return jsonResponse(route, 200, []);
    if (endpoint === "/usage" && method === "GET") return jsonResponse(route, 200, {});
    if (endpoint === "/planner" && method === "GET") return jsonResponse(route, 200, {});
    if (endpoint === "/memory" && method === "GET") return jsonResponse(route, 200, {});

    // Unused read endpoints stay deterministic, while writes stay visible in the
    // request ledger so the scenarios can assert that no conversation was sent.
    if (method === "GET") return jsonResponse(route, 200, []);
    return jsonResponse(route, 204, {});
  });
}

function makeAgent(id, draft) {
  return { id, name: draft.name, title: null, description: null, instructions: draft.purpose,
    provider: draft.provider, model: draft.model, workspace_path: null, approval_mode: "ask", pinned: false,
    memory_enabled: true, recall_enabled: true, archived_at: null, computer_id: null, computer: null };
}

function recordPageErrors(page, bucket) {
  page.on("pageerror", (error) => bucket.push(error.stack || error.message));
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}

async function noHorizontalOverflow(page, width) {
  const result = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(result.viewport, width, `Expected ${width}px viewport, got ${result.viewport}px`);
  assert.ok(result.scroll <= result.viewport, `Horizontal overflow: ${result.scroll}px document at ${result.viewport}px viewport`);
}

async function setupPage(browser, baseUrl, state, pageErrors, { desktopBridge = false, width = 1280 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  if (desktopBridge) await context.addInitScript(() => {
    window.__smokePermissionCalls = [];
    window.__smokePermissionStatusReads = 0;
    window.openDots = {
      updates: {},
      desktopPermissions: async (action = "status") => {
        window.__smokePermissionCalls.push(action);
        if (action !== "status") return { supported: true, accessibility: false, screen_recording: false };
        window.__smokePermissionStatusReads++;
        const granted = window.__smokePermissionStatusReads > 1;
        return { supported: true, accessibility: granted, screen_recording: granted };
      },
    };
  });
  const page = await context.newPage();
  recordPageErrors(page, pageErrors);
  await installApiMocks(page, state);
  return { context, page, goto: (route) => page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" }) };
}

async function clickContinue(page) {
  const button = page.getByRole("button", { name: "Continue", exact: true });
  await expect(button).toBeEnabled({ timeout: 10000 });
  await button.click();
}

async function waitSaved(page) {
  await page.getByRole("status").filter({ hasText: "Progress saved." }).waitFor({ timeout: 5000 });
}

async function runScenario(name, fn, report) {
  const errors = [];
  try {
    await fn(errors);
    if (errors.length) throw new Error(`Uncaught browser exceptions:\n${errors.join("\n")}`);
    report.push({ name, status: "PASS" });
  } catch (error) {
    report.push({ name, status: "FAIL", error: error.stack || error.message, pageErrors: errors });
  }
}

async function main() {
  assert.ok(fs.existsSync(STATIC_ROOT), `Static export not found: ${STATIC_ROOT}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = http.createServer(serveStatic);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let browser = null;
  const report = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
    await runScenario("Claude onboarding, autosave, reload, complete, unsent draft, and 390px layout", async (errors) => {
      const state = makeMockState();
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors, { width: 390 });
      try {
        await goto("/onboarding/");
        await page.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        await noHorizontalOverflow(page, 390);
        await screenshot(page, "claude-welcome-390");
        await clickContinue(page);
        await page.getByRole("heading", { name: "Connect an AI" }).waitFor();
        await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled({ timeout: 10000 });
        await clickContinue(page);
        await page.getByRole("heading", { name: "Give your agent a purpose" }).waitFor();
        await page.getByLabel("Create a starter agent").check();
        await page.getByRole("button", { name: "Project researcher" }).click();
        await page.getByLabel("Agent name").fill("Research Desk");
        await page.getByLabel("What should it help with?").fill("Research and compare sources; flag uncertainty.");
        await page.getByLabel("First request").fill("Compare three approaches for my project.");
        await waitSaved(page);
        assert.equal(state.onboarding.draft.name, "Research Desk");
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Give your agent a purpose" }).waitFor();
        assert.equal(await page.getByLabel("Agent name").inputValue(), "Research Desk");
        assert.equal(await page.getByLabel("First request").inputValue(), "Compare three approaches for my project.");
        await noHorizontalOverflow(page, 390);
        await screenshot(page, "claude-role-restored-390");
        await clickContinue(page);
        await page.getByRole("heading", { name: "Ready for your first conversation" }).waitFor();
        await page.getByRole("button", { name: "Open chat" }).click();
        await page.getByRole("textbox").waitFor({ timeout: 10000 });
        const composer = page.getByRole("textbox");
        await composer.waitFor({ timeout: 10000 });
        await page.waitForFunction((expected) => {
          const box = document.querySelector("textarea");
          return box?.value === expected;
        }, "Compare three approaches for my project.", { timeout: 10000 });
        assert.equal(await composer.inputValue(), "Compare three approaches for my project.");
        await noHorizontalOverflow(page, 390);
        assert.equal(state.createdThreadCount, 0, "opening the first conversation must not create a thread");
        assert.equal(state.sentTurnCount, 0, "opening the first conversation must not send the draft");
        assert.equal(state.requests.some((req) => req.endpoint === "/threads" && req.method === "POST"), false);
        assert.equal(state.requests.some((req) => /^\/threads\/\d+\/turns$/.test(req.endpoint)), false);
        await screenshot(page, "claude-unsent-chat-390");
      } finally { await context.close(); }
    }, report);

    await runScenario("Codex is selectable as ready; skip and replay setup", async (errors) => {
      const state = makeMockState();
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors);
      try {
        await goto("/onboarding/");
        await page.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        await clickContinue(page);
        await page.getByLabel("Engine").selectOption("codex");
        await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled({ timeout: 10000 });
        assert.equal(state.onboarding.draft.provider, "claude", "selection is local until autosaved");
        await page.getByRole("button", { name: "Set up later" }).click();
        await page.waitForURL(/\/chat\/$/);
        assert.equal(state.onboarding.status, "skipped");
        await goto("/onboarding/");
        await page.getByRole("heading", { name: "Set up when you are ready" }).waitFor();
        await page.getByRole("button", { name: "Continue setup" }).click();
        await page.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        assert.equal(state.onboarding.status, "pending");
        assert.ok(state.requests.some((req) => req.endpoint === "/onboarding/skip" && req.method === "POST"));
        assert.ok(state.requests.some((req) => req.endpoint === "/onboarding/restart" && req.method === "POST"));
        await screenshot(page, "setup-replayed");
      } finally { await context.close(); }
    }, report);

    await runScenario("Setup progress read failure exposes retry and recovers", async (errors) => {
      const state = makeMockState({ failInitialOnboardingReads: 1 });
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors);
      try {
        await goto("/onboarding/");
        await page.getByText("Setup progress is unavailable.").waitFor();
        await page.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
        await page.getByRole("button", { name: "Try again" }).click();
        await page.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        assert.equal(state.onboardingReads, 2);
        await screenshot(page, "read-failure-recovered");
      } finally { await context.close(); }
    }, report);

    await runScenario("Two tabs surface an onboarding version conflict and reload the saved revision", async (errors) => {
      const state = makeMockState();
      const { context, page: first, goto } = await setupPage(browser, baseUrl, state, errors);
      const secondErrors = [];
      const second = await context.newPage();
      recordPageErrors(second, secondErrors);
      await installApiMocks(second, state);
      try {
        await goto("/onboarding/");
        await second.goto(`${baseUrl}/onboarding/`, { waitUntil: "networkidle" });
        await first.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        await second.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor();
        await clickContinue(first);
        await waitSaved(first);
        await clickContinue(second);
        await second.getByRole("alert").filter({ hasText: "Setup changed in another window" }).waitFor();
        await second.getByRole("button", { name: "Reload saved progress" }).click();
        await second.getByRole("heading", { name: "Connect an AI" }).waitFor();
        assert.equal(state.onboarding.version, 2);
        assert.equal(state.onboarding.draft.step, 1);
        assert.equal(state.requests.filter((req) => req.endpoint === "/onboarding" && req.method === "PUT").length, 2);
        assert.equal(secondErrors.length, 0, secondErrors.join("\n"));
        await screenshot(second, "two-tab-conflict-reloaded");
      } finally { await context.close(); }
    }, report);

    await runScenario("Returning account opens chat without forcing the setup wizard", async (errors) => {
      const state = makeMockState();
      state.onboarding.status = "configured";
      state.onboarding.existing_agents = true;
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors);
      try {
        await goto("/chat/");
        await page.getByRole("textbox").waitFor({ timeout: 10000 });
        assert.match(page.url(), /\/chat\//);
        assert.equal(await page.getByRole("heading", { name: "Welcome to Open Duet" }).count(), 0);
        assert.ok(state.requests.some((req) => req.endpoint === "/onboarding" && req.method === "GET"));
        assert.equal(state.requests.some((req) => req.endpoint === "/onboarding/restart"), false);
        await screenshot(page, "returning-user-chat");
      } finally { await context.close(); }
    }, report);

    await runScenario("Desktop can open chat while optional native permissions are denied", async (errors) => {
      const state = makeMockState({ desktop: true });
      state.accountSignedIn = true; state.profileBound = true;
      state.onboarding.draft.step = 3;
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors, { desktopBridge: true, width: 390 });
      try {
        await goto("/onboarding/");
        await page.getByRole("heading", { name: "Ready for your first conversation" }).waitFor();
        await page.getByRole("heading", { name: "Mac permissions (optional)" }).waitFor();
        await page.getByText("Accessibility: Not granted").waitFor();
        await page.getByText("Screen Recording: Not granted").waitFor();
        await expect(page.getByRole("button", { name: "Open chat" })).toBeEnabled();
        await page.getByRole("button", { name: "Open chat" }).click();
        await page.getByRole("textbox").waitFor({ timeout: 10000 });
        assert.deepEqual(await page.evaluate(() => window.__smokePermissionCalls), ["status"]);
        assert.equal(state.requests.some((req) => req.method === "POST" && req.endpoint === "/agents"), false, "opening chat must not configure an agent");
        assert.equal(state.requests.some((req) => req.method === "POST" && /^\/threads/.test(req.endpoint)), false, "opening chat must not create a conversation");
        await noHorizontalOverflow(page, 390);
        await screenshot(page, "desktop-chat-with-permissions-denied-390");
      } finally { await context.close(); }
    }, report);

    await runScenario("Desktop permission status recheck reflects a grant without opening settings", async (errors) => {
      const state = makeMockState({ desktop: true });
      state.accountSignedIn = true; state.profileBound = true;
      state.onboarding.draft.step = 3;
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors, { desktopBridge: true });
      try {
        await goto("/onboarding/");
        await page.getByText("Accessibility: Not granted").waitFor();
        await page.getByRole("button", { name: "Check permissions again" }).click();
        await page.getByText("Accessibility: Granted").waitFor();
        await page.getByText("Screen Recording: Granted").waitFor();
        assert.deepEqual(await page.evaluate(() => window.__smokePermissionCalls), ["status", "status"]);
        assert.equal(state.requests.some((req) => req.method !== "GET" && /permissions|desktop-permissions/i.test(req.endpoint)), false);
        assert.equal(state.requests.some((req) => req.method === "POST" && req.endpoint === "/agents"), false);
        await screenshot(page, "desktop-permissions-rechecked");
      } finally { await context.close(); }
    }, report);

    await runScenario("Desktop email login keeps auth tokens out of email requests and requires explicit adoption", async (errors) => {
      const state = makeMockState({ desktop: true });
      const { context, page, goto } = await setupPage(browser, baseUrl, state, errors, { desktopBridge: true, width: 390 });
      try {
        await goto("/chat/");
        await page.getByRole("heading", { name: "Sign in to Open Duet" }).waitFor();
        await page.getByLabel("Email").fill("owner@example.test");
        await page.getByRole("button", { name: "Email me a code" }).click();
        await page.getByText("Check your email for a sign-in code.").waitFor();
        const start = state.requests.find((req) => req.endpoint === "/desktop-account/email/start");
        assert.ok(start, "email-start request was recorded");
        assert.deepEqual(Object.keys(start.body).sort(), ["email"]);
        assert.equal(Object.keys(start.body).some((key) => /token|secret|password/i.test(key)), false);
        assert.equal(start.headers.authorization, undefined, "email-start request must not carry an Authorization token");
        await page.getByLabel("Email code").fill("000000");
        const verify = page.getByRole("button", { name: "Verify and continue" });
        assert.equal(await verify.isDisabled(), true, "adoption must be confirmed before verification");
        await page.getByLabel(/Use this account for this local profile/).check();
        assert.equal(await verify.isDisabled(), false);
        await verify.click();
        await page.getByRole("alert").filter({ hasText: "code is invalid" }).waitFor();
        assert.equal(state.accountSignedIn, false, "invalid code must not sign in");
        await page.getByLabel("Email code").fill("123456");
        await verify.click();
        await page.getByRole("heading", { name: "Welcome to Open Duet" }).waitFor({ timeout: 10000 });
        assert.equal(state.accountSignedIn, true);
        assert.equal(state.profileBound, true);
        const verifyRequest = state.requests.find((req) => req.endpoint === "/desktop-account/email/verify" && req.body?.code === "123456");
        assert.deepEqual(Object.keys(verifyRequest.body).sort(), ["adopt_local_data", "code", "email"]);
        assert.equal(Object.keys(verifyRequest.body).some((key) => /token|secret|password/i.test(key)), false);
        assert.equal(verifyRequest.headers.authorization, undefined);
        assert.ok(state.requests.some((req) => req.endpoint === "/onboarding" && req.method === "GET"), "successful sign-in continues into setup");
        await noHorizontalOverflow(page, 390);
        await screenshot(page, "desktop-email-login-and-setup");
      } finally { await context.close(); }
    }, report);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write(`${JSON.stringify({ baseUrl, screenshots: SHOTS, scenarios: report }, null, 2)}\n`);
  if (report.some((item) => item.status === "FAIL")) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
