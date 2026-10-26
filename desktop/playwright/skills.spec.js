// Real desktop UI checks for the message skill menu. The app runs with an isolated
// profile and launch-token authentication. Skills reads and the explicit test send are controlled.
const { test: base, expect, chromium } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp } = require("../e2e/app");

const skills = [
  { name: "alpha", description: "Alpha instructions", enabled: true, source: "user", bytes: 12, updated_at: null },
  { name: "alpine", description: "Alpine instructions", enabled: true, source: "user", bytes: 13, updated_at: null },
  { name: "algebra", description: "Algebra instructions", enabled: true, source: "user", bytes: 14, updated_at: null },
  { name: "altitude", description: "Altitude instructions", enabled: true, source: "user", bytes: 15, updated_at: null },
  { name: "archived", description: "Disabled skill", enabled: false, source: "user", bytes: 16, updated_at: null },
];

const test = base.extend({
  app: [async ({}, use) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-dots-skills-e2e-"));
    const app = await launchApp({ dataDir });
    app.failureCount = 0;
    let browser;
    let failed = false;
    try {
      await app.page();
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.debugPort}`);
      const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://127.0.0.1:"));
      await page.getByRole("button", { name: "Set up later" }).click();
      await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
      app.playwrightPage = page;
      await use(app);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await browser?.close().catch(() => {});
      app.destroy();
      const stopped = await Promise.race([
        app.exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (failed || app.failureCount > 0 || !stopped) {
        console.error(`Retaining failed skills-test profile for diagnosis: ${dataDir}`);
      } else {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  }, { scope: "worker", timeout: 180_000 }],
  page: async ({ app }, use) => {
    const page = app.playwrightPage;
    await page.goto(new URL("/chat/", page.url()).href);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    try {
      await use(page);
    } catch (error) {
      app.failureCount++;
      throw error;
    }
  },
});

async function makeAgent(page, name) {
  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New agent" }).first().click();
  const form = page.getByRole("dialog", { name: "New agent" });
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await form.getByRole("button", { name: "Save" }).click();
  const agents = page.getByRole("dialog", { name: "Agents" });
  await expect(agents.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  await agents.getByRole("button", { name: "Close" }).click();
  await page.getByRole("combobox", { name: "Agent for this chat" }).selectOption({ label: name });
  await expect(page.getByRole("combobox", { name: "Agent for this chat" })).toHaveValue(/\d+/);
}

async function mockSkills(page, getCatalog = () => skills) {
  await page.route("**/agents/*/skills", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(getCatalog(route.request().url())) });
  });
}

test("slash completions show enabled skills; arrow navigation and Enter select without sending", async ({ page }, testInfo) => {
  await mockSkills(page);
  await makeAgent(page, "Menu keyboard agent");
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("/al");
  const listbox = page.getByRole("listbox", { name: "Skills" });
  const options = listbox.getByRole("option");
  await expect(options).toHaveCount(4);
  await page.screenshot({ path: process.env.SKILLS_MENU_SCREENSHOT ?? testInfo.outputPath("skills-menu.png") });
  await expect(listbox.getByRole("option", { name: /archived/ })).toHaveCount(0);
  await expect(box).toHaveAttribute("aria-controls", /.+/);
  await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", await options.nth(1).getAttribute("id"));
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  let turnRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/threads\/\d+\/turns(?:\?|$)/.test(request.url())) turnRequests++;
  });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Skills for this message" })).toContainText("alpine");
  await expect(box).toHaveValue("");
  expect(turnRequests).toBe(0);
});

test("Tab selects; Escape dismisses matching options without losing draft; Enter sends typed text", async ({ page }) => {
  await mockSkills(page);
  await makeAgent(page, "Menu dismissal agent");
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("/alp");
  await box.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", isComposing: true, bubbles: true,
  })));
  await expect(box).toHaveValue("/alp");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("list", { name: "Skills for this message" })).toContainText("alpha");

  await box.fill("line");
  await page.keyboard.press("Shift+Enter");
  await expect(box).toHaveValue("line\n");

  await box.fill("/alp");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toHaveValue("/alp");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
  await box.fill("/alpi");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await box.fill("/alp");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
  let sentBody;
  await page.route("**/threads/*/turns", async (route) => {
    sentBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
  });
  await box.press("Enter");
  await expect.poll(() => sentBody).toEqual(expect.objectContaining({ prompt_text: "/alp" }));
});

test("mouse selection and the picker enforce three skills and agent changes reload the catalog", async ({ page }) => {
  let firstAgentId = null;
  await mockSkills(page, (url) => {
    const agentId = url.match(/\/agents\/(\d+)\/skills/)?.[1];
    if (firstAgentId === null && agentId) firstAgentId = agentId;
    return agentId === firstAgentId ? skills : [
      { name: "beta", description: "Only for the second agent", enabled: true, source: "user", bytes: 11, updated_at: null },
    ];
  });
  await makeAgent(page, "Menu first agent");
  const firstId = await page.getByRole("combobox", { name: "Agent for this chat" }).inputValue();
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("/alp");
  await page.getByRole("listbox", { name: "Skills" }).getByRole("option", { name: /alpine/ }).click();
  const selected = page.getByRole("list", { name: "Skills for this message" });
  await expect(selected).toContainText("alpine");

  const picker = page.getByRole("button", { name: "Pick skills" });
  await picker.click();
  const pickGroup = page.getByRole("group", { name: "Pick skills" });
  for (const name of ["alpha", "algebra"]) await pickGroup.getByLabel(new RegExp(`/${name}`)).check();
  await expect(selected.getByRole("listitem")).toHaveCount(3);
  await expect(pickGroup.getByLabel(/\/altitude/)).toBeDisabled();

  await picker.click();
  await box.fill("/alt");
  await expect(box).toHaveValue("/alt");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Remove one to choose another" })).toBeVisible();
  for (const name of ["alpine", "alpha", "algebra"]) {
    await page.getByRole("button", { name: `Remove skill ${name}` }).click();
  }
  await expect(selected).toHaveCount(0);

  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New agent" }).first().click();
  const form = page.getByRole("dialog", { name: "New agent" });
  await form.getByRole("textbox", { name: "Name" }).fill("Menu second agent");
  await form.getByRole("button", { name: "Save" }).click();
  const agents = page.getByRole("dialog", { name: "Agents" });
  await agents.getByRole("button", { name: "Close" }).click();
  await page.getByRole("combobox", { name: "Agent for this chat" }).selectOption({ label: "Menu second agent" });
  const secondId = await page.getByRole("combobox", { name: "Agent for this chat" }).inputValue();
  expect(secondId).not.toBe(firstId);
  await expect(selected).toHaveCount(0);
  await page.getByRole("combobox", { name: "Agent for this chat" }).selectOption({ label: "Menu first agent" });
  await box.fill("/al");
  await expect(page.getByRole("listbox", { name: "Skills" }).getByRole("option")).toHaveCount(4);
  await box.fill("/beta");
  await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Agent for this chat" }).selectOption({ label: "Menu second agent" });
  await box.fill("/b");
  const skillOptions = page.getByRole("listbox", { name: "Skills" }).getByRole("option");
  await expect(skillOptions).toHaveCount(1);
  await expect(skillOptions).toContainText("/beta");
  await expect(page.getByRole("list", { name: "Skills for this message" })).toHaveCount(0);
});
