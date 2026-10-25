import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_CHORD_KEYS, assertReleasesKeys } from "./a11y-invariants.ts";
import { isReleaseChord } from "./desktop-rfb.ts";

// The single constant both the type-level contract and the runtime check read.
const DECLARED = RELEASE_CHORD_KEYS;

test("every declared release key actually releases (true: onEscape fires)", () => {
  // Mirror the LiveDesktop handler: when the pressed key is a declared escape
  // key, the surface must call onEscape instead of forwarding to the guest.
  for (const key of DECLARED) {
    let released = false;
    const onEscape = () => { released = true; };
    const event = { key, ctrlKey: true, shiftKey: true };
    // The runtime predicate the handler gates on:
    const isRelease = key === "F6" ? event.key === "F6" : isReleaseChord(event);
    if (isRelease) onEscape();
    assert.equal(released, true, `declared key ${key} must release control`);
  }
});

test("declared keys and intercepted chords agree in both directions (AC4)", () => {
  // Every declared key is a key the runtime predicate can fire on.
  for (const key of DECLARED) {
    const asChord = key === "F6"
      ? isReleaseChord({ key })
      : isReleaseChord({ key, ctrlKey: true, shiftKey: true });
    assert.equal(asChord, true, `escapeKeys declares ${key} but isReleaseChord does not fire`);
  }
  // No chord the runtime fires is absent from the declared list.
  const fired = [
    { key: "F6" },
    { key: "Escape", ctrlKey: true, shiftKey: true },
  ].filter(isReleaseChord).map((e) => e.key);
  for (const key of fired) {
    assert.ok(DECLARED.includes(key), `isReleaseChord fires on ${key} but escapeKeys omits it`);
  }
});

test("a surface may not declare an empty release list (AC3 companion / Failure-mode guard)", () => {
  assert.throws(() => assertReleasesKeys([]), /must declare at least one release key/);
  assert.doesNotThrow(() => assertReleasesKeys(DECLARED));
});

test("the shipped chords are the ones the product documents", () => {
  // F6 and Ctrl+Shift+Escape are the release chords named in the canvas aria-label.
  assert.deepEqual([...DECLARED], ["F6", "Escape"]);
  assert.equal(isReleaseChord({ key: "F6" }), true);
  assert.equal(isReleaseChord({ key: "Escape", ctrlKey: true, shiftKey: true }), true);
  assert.equal(isReleaseChord({ key: "Tab" }), false);
});
