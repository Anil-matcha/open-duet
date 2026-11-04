import assert from "node:assert/strict";
import { test } from "node:test";
import { isUpdateDismissed, dismissUpdate, setCachedVersionInfoForTest } from "./use-version-update.ts";

test("isUpdateDismissed returns false without window or storage", () => {
  assert.equal(isUpdateDismissed("0.9.0"), false);
  assert.equal(isUpdateDismissed(null), false);
});

test("dismissUpdate stores dismissal flag in window.localStorage", () => {
  const storage = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, val) => storage.set(key, String(val)),
    },
  };

  assert.equal(isUpdateDismissed("0.9.0"), false);
  dismissUpdate("0.9.0");
  assert.equal(isUpdateDismissed("0.9.0"), true);
  assert.equal(isUpdateDismissed("0.9.1"), false);

  delete global.window;
});

test("setCachedVersionInfoForTest sets cached version info", () => {
  const sample = {
    current_version: "0.8.1",
    commit: "abc1234",
    latest_version: "0.9.0",
    update_available: true,
    install_kind: "git",
    update_command: "git pull && uv sync",
    release_notes_url: "https://github.com/Anil-matcha/open-duet/releases",
  };
  setCachedVersionInfoForTest(sample);
  setCachedVersionInfoForTest(null);
});

