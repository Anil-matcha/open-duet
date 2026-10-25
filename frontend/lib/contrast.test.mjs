import assert from "node:assert/strict";
import { test } from "node:test";
import { check, composite, luminance, oklchToSrgb, parseColor, ratio } from "../scripts/check-contrast.mjs";

test("the contrast formula matches known values", () => {
  assert.equal(Math.round(luminance({ r: 0, g: 0, b: 0 })), 0);
  assert.equal(luminance({ r: 1, g: 1, b: 1 }), 1);
  assert.equal(ratio(parseColor("#000000"), parseColor("#ffffff")), 21);
  assert.ok(Math.abs(ratio(parseColor("#777777"), parseColor("#ffffff")) - 4.48) < 0.02);
});

test("alpha is composited over the background before the ratio (AC4)", () => {
  // #ffffff22 over #111111 -> #313131, not raw white. The naive (uncomposited)
  // path would report 18.9:1; the honest gate reports ~1.45:1.
  const fg = parseColor("#ffffff22");
  const bg = parseColor("#111111");
  const composited = composite(fg, bg);
  const hex = "#" + [composited.r, composited.g, composited.b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  assert.equal(hex, "#313131");
  assert.ok(Math.abs(ratio(composited, bg) - 1.446) < 0.01);
  assert.ok(ratio(parseColor("#ffffff"), bg) > 18);
});

test("rgb(...) and oklch(...) literals parse to sRGB (Tailwind palette path)", () => {
  const rgb = parseColor("rgb(0 0 0 / 0.6)");
  assert.deepEqual({ ...rgb }, { r: 0, g: 0, b: 0, alpha: 0.6 });
  const ok = parseColor("oklch(21% 0.006 285.885)");
  assert.ok(ok.r > 0.05 && ok.r < 0.15, "zinc-900 is a dark near-neutral");
  assert.equal(ok.alpha, 1);
  // A full-white oklch maps to white.
  const w = oklchToSrgb(1, 0, 0);
  assert.ok(Math.abs(w.r - 1) < 0.01 && Math.abs(w.g - 1) < 0.01 && Math.abs(w.b - 1) < 0.01);
});

test("the gate measures real pairs and discovers its colour sources", () => {
  const result = check();
  // Colour sources are discovered by scanning, not hard-coded.
  assert.ok(result.files.some((f) => f.endsWith("app/globals.css")), "globals.css must be ingested");
  // Every reported failure names a theme, a pair and a finite ratio — the old
  // gate could report nothing; the honest gate reports at least the --line set.
  for (const f of result.failures) {
    assert.ok(f.theme && f.pair && Number.isFinite(f.ratio), `malformed failure: ${JSON.stringify(f)}`);
  }
  assert.ok(result.failures.some((f) => f.pair.includes("line on")), "the --line pairs must be measured (AC5)");
  assert.ok(result.failures.some((f) => f.pair.includes("scrim on")), "the --scrim pair must be measured (AC5)");
});
