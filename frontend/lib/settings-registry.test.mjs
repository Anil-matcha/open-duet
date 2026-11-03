import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SETTINGS_PAGES } from "./settings-nav.ts";
import {
  rankSettings,
  SETTINGS_REGISTRY,
  settingsControlMatches,
  settingsTabForAnchor,
  shouldExpandBeforeSettingsFocus,
} from "./settings-registry.ts";

const pageMarkupFiles = [
  "../components/settings/GeneralSettings.tsx",
  "../components/settings/ProfileSettings.tsx",
  "../components/settings/EnginesSettings.tsx",
  "../components/settings/ChannelsSettings.tsx",
  "../components/settings/ApprovalsSettings.tsx",
  "../components/settings/NotificationsSettings.tsx",
  "../components/settings/AccountSettings.tsx",
];

const renderedPageMarkup = pageMarkupFiles.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
const idsInMarkup = renderedPageMarkup.flatMap((source) =>
  [...source.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((match) => match[1]),
);
const settingIdsInMarkup = idsInMarkup.filter((id) => id.startsWith("setting-"));

test("registry entries are complete and have unique ids and anchors", () => {
  assert.ok(SETTINGS_REGISTRY.length > 0);
  assert.equal(new Set(SETTINGS_REGISTRY.map((entry) => entry.id)).size, SETTINGS_REGISTRY.length);
  assert.equal(new Set(SETTINGS_REGISTRY.map((entry) => entry.anchorId)).size, SETTINGS_REGISTRY.length);

  const hrefs = new Map(SETTINGS_PAGES.map((page) => [page.id, page.href]));
  for (const entry of SETTINGS_REGISTRY) {
    assert.ok(entry.title.trim(), `${entry.id} has a title`);
    assert.ok(entry.section.trim(), `${entry.id} has a section`);
    assert.ok(entry.keywords.length, `${entry.id} has keywords`);
    assert.equal(entry.pageHref, hrefs.get(entry.page), `${entry.id} uses its page route`);
  }
});

test("every registry anchor exists in settings page markup and no settings anchor is duplicated", () => {
  assert.equal(new Set(idsInMarkup).size, idsInMarkup.length, "settings page markup has unique literal ids");
  for (const entry of SETTINGS_REGISTRY) {
    assert.ok(settingIdsInMarkup.includes(entry.anchorId), `${entry.anchorId} is present in settings page markup`);
  }
});

test("search ranks likely settings first and searches titles plus keywords", () => {
  assert.equal(rankSettings("theme")[0]?.entry.id, "general-appearance");
  assert.equal(rankSettings("api key")[0]?.entry.id, "engine-api-key");
  assert.equal(rankSettings("telegram")[0]?.entry.id, "channels-telegram");
  assert.equal(rankSettings("channels")[0]?.entry.id, "channels-telegram");
  assert.ok(rankSettings("approvals").some(({ entry }) => entry.page === "approvals"));
  assert.deepEqual(rankSettings("   "), []);
});

test("approval anchors select their matching tab", () => {
  assert.equal(settingsTabForAnchor("setting-approvals-rules"), "rules");
  assert.equal(settingsTabForAnchor("setting-approvals-decisions"), "decisions");
  assert.equal(settingsTabForAnchor("setting-approvals-health"), "health");
  assert.equal(settingsTabForAnchor("unknown-anchor"), null);

  const approvalsPanel = readFileSync(new URL("../components/approvals/ApprovalsPanel.tsx", import.meta.url), "utf8");
  assert.match(approvalsPanel, /settingsTabForAnchor\(window\.location\.hash\.slice\(1\)\)/);
  assert.match(approvalsPanel, /addEventListener\("hashchange", syncTabToAnchor\)/);
});

test("API key focus skips the card toggle and opens a collapsed owner", () => {
  assert.equal(settingsControlMatches("api key", "Collapse Cursor settings"), false);
  assert.equal(settingsControlMatches("api key", "API key (optional)"), true);
  assert.equal(shouldExpandBeforeSettingsFocus(false, "false"), true);
  assert.equal(shouldExpandBeforeSettingsFocus(true, "false"), false);
  assert.equal(shouldExpandBeforeSettingsFocus(false, "true"), false);

  const engineSettings = readFileSync(new URL("../components/EngineSettings.tsx", import.meta.url), "utf8");
  assert.match(engineSettings, /setting-engine-api-key/);
  assert.match(engineSettings, /setting-engine-endpoint/);
  assert.match(engineSettings, /data-setting-id=\{settingId\}/);
  assert.match(engineSettings, /data-setting-expand-for=\{settingAnchors \|\| undefined\}/);
});
