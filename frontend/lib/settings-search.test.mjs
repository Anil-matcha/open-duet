import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsSearchKeyAction } from "./settings-registry.ts";

test("settings search supports wrapped arrow navigation and Home/End", () => {
  assert.deepEqual(settingsSearchKeyAction("ArrowDown", 2, 3), { type: "move", active: 0 });
  assert.deepEqual(settingsSearchKeyAction("ArrowUp", 0, 3), { type: "move", active: 2 });
  assert.deepEqual(settingsSearchKeyAction("ArrowDown", 0, 0), { type: "move", active: 0 });
  assert.deepEqual(settingsSearchKeyAction("Home", 2, 4), { type: "move", active: 0 });
  assert.deepEqual(settingsSearchKeyAction("End", 0, 4), { type: "move", active: 3 });
});

test("settings search Enter selects, Escape clears, and other keys pass through", () => {
  assert.deepEqual(settingsSearchKeyAction("Enter", 1, 3), { type: "select" });
  assert.deepEqual(settingsSearchKeyAction("Escape", 1, 3), { type: "clear" });
  assert.equal(settingsSearchKeyAction("a", 0, 3), null);
});
