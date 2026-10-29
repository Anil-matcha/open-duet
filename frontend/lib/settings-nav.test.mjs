import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_SETTINGS, SETTINGS_PAGES, activeSettingsPage, isSetupPage } from "./settings-nav.ts";

test("each Settings page has a unique address, and the engine address is one of them", () => {
  assert.equal(new Set(SETTINGS_PAGES.map((page) => page.href)).size, SETTINGS_PAGES.length);
  assert.ok(SETTINGS_PAGES.some((page) => page.href === ENGINE_SETTINGS));
  assert.equal(SETTINGS_PAGES[0].href, "/settings/");
});

test("the current page is found with or without a trailing slash and under a base path", () => {
  const label = (path) => activeSettingsPage(path).label;
  assert.equal(label("/settings"), "General");
  assert.equal(label("/settings/"), "General");
  assert.equal(label("/settings/engines"), "Engines");
  assert.equal(label("/settings/engines/"), "Engines");
  assert.equal(label("/app/settings/approvals/"), "Approvals");
  assert.equal(label("/settings/account"), "Account & privacy");
});

test("every Settings page and the setup guide skip the new-owner redirect; other pages do not", () => {
  for (const page of SETTINGS_PAGES) assert.equal(isSetupPage(page.href), true, page.href);
  assert.equal(isSetupPage("/onboarding/"), true);
  assert.equal(isSetupPage("/app/settings/engines"), true);
  for (const other of ["/chat/", "/apps/", "/tasks/", "/mysettings/", "/settingsx/"]) assert.equal(isSetupPage(other), false, other);
});
