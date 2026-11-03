import assert from "node:assert/strict";
import { test } from "node:test";
import { tabTargetForKey } from "./tab-navigation.ts";

const tabs = ["rules", "decisions", "health"];

test("arrow keys move through tabs and wrap at either end", () => {
  assert.equal(tabTargetForKey(tabs, "rules", "ArrowRight"), "decisions");
  assert.equal(tabTargetForKey(tabs, "decisions", "ArrowLeft"), "rules");
  assert.equal(tabTargetForKey(tabs, "health", "ArrowRight"), "rules");
  assert.equal(tabTargetForKey(tabs, "rules", "ArrowLeft"), "health");
});

test("Home and End select the first and last tabs", () => {
  assert.equal(tabTargetForKey(tabs, "decisions", "Home"), "rules");
  assert.equal(tabTargetForKey(tabs, "decisions", "End"), "health");
});

test("unrelated keys, unknown tabs, and empty tab lists have no target", () => {
  assert.equal(tabTargetForKey(tabs, "rules", "Enter"), null);
  assert.equal(tabTargetForKey(tabs, "unknown", "ArrowRight"), null);
  assert.equal(tabTargetForKey([], "rules", "Home"), null);
});
