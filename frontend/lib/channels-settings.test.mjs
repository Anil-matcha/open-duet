import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const component = readFileSync(new URL("../components/ConnectTelegram.tsx", import.meta.url), "utf8");
const channels = readFileSync(new URL("../components/settings/ChannelsSettings.tsx", import.meta.url), "utf8");

test("Channels Settings uses the settings variant of Telegram linking", () => {
  assert.match(channels, /<ConnectTelegram[^>]*variant="settings"/);
  assert.match(component, /variant\?: "legacy" \| "settings"/);
});

test("the Telegram settings variant presents connection status and cancellable link codes", () => {
  const start = component.indexOf('if (variant === "settings")');
  const end = component.indexOf("\n  if (userId)", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const settingsVariant = component.slice(start, end);

  for (const messageKey of [
    "channels.notConnected",
    "channels.connectedAs",
    "channels.linkTelegram",
    "channels.disconnect",
    "channels.copy",
    "channels.copied",
    "channels.waitingForLink",
    "channels.expiresAt",
  ]) {
    assert.ok(settingsVariant.includes(messageKey), `${messageKey} appears in the settings variant`);
  }
  assert.match(settingsVariant, /\/link \{linkCode\.code\}/);
  assert.match(settingsVariant, /onClick=\{cancelLink\}/);
  assert.doesNotMatch(settingsVariant, /get started|continue without telegram|\bguest\b/i);
});

test("Boat tasks stays a compact SettingsCard row with a button-style link", () => {
  const boatTasks = channels.slice(channels.indexOf('id="setting-channels-boat-tasks"'));
  assert.match(boatTasks, /description=\{<span className="block truncate">\{t\("channels\.boatTasksCompactDescription"\)\}<\/span>\}/);
  assert.match(boatTasks, /channels\.openBoatTasks/);
  assert.match(boatTasks, /action=\{/);
  assert.doesNotMatch(boatTasks, /channels\.boatTasksLink/);
});
