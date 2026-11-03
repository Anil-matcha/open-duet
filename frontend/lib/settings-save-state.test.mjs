import assert from "node:assert/strict";
import { test } from "node:test";
import { saveBarState } from "../components/settings/save-bar-state.ts";

test("SaveBar reports dirty and saving states", () => {
  assert.equal(saveBarState({ dirty: true, saving: false, error: null, saved: false }), "dirty");
  assert.equal(saveBarState({ dirty: true, saving: true, error: null, saved: false }), "saving");
});

test("SaveBar reports errors before dirty state and saved after a clean save", () => {
  assert.equal(saveBarState({ dirty: true, saving: false, error: "Conflict", saved: false }), "error");
  assert.equal(saveBarState({ dirty: false, saving: false, error: null, saved: true }), "saved");
  assert.equal(saveBarState({ dirty: false, saving: false, error: null, saved: false }), "idle");
});
