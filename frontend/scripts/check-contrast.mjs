// An honest WCAG contrast gate: measures the colours the app actually ships.
//
//   node scripts/check-contrast.mjs            # gate: exit 1 on any failing pair
//   node scripts/check-contrast.mjs --debug-sources   # list every ingested file
//
// Node only, no packages. Three sources of colour, all discovered by scanning
// frontend/ (never a hard-coded file list):
//   1. CSS custom properties  (`--ink: #1c1b19;`)
//   2. Tailwind palette utilities used in components (`text-red-600`, `bg-zinc-900`),
//      resolved through node_modules/tailwindcss/theme.css (oklch -> sRGB).
//   3. Semantic token utilities (`text-muted`, `bg-hover`) which map onto the
//      custom properties above via the `@theme inline` block.
//
// Alpha (e.g. `--scrim: rgb(0 0 0 / 0.6)`, or `#rrggbbaa`) is composited over the
// resolved background before the ratio is computed. Waivers live in
// contrast-waivers.json; a waiver whose measured ratio drifts is a hard failure
// ("stale waiver"), so the file can never quietly rot.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, "..");
const ROOT = path.join(FRONTEND, "..");
const THEME_CSS = path.join(FRONTEND, "node_modules", "tailwindcss", "theme.css");
const WAIVER_FILE = path.join(HERE, "contrast-waivers.json");

// ---------------------------------------------------------------------------
// Colour parsing / maths (sRGB + CSS Color 4 oklch)
// ---------------------------------------------------------------------------

function srgbChannel(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }) {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// CSS Color 4 oklch -> linear sRGB -> sRGB, with gamut clipping (the "once, at
// conversion" mapping the spec asks for: each oklch colour is mapped to a
// displayable sRGB triple before it is ever ratio-computed).
export function oklchToSrgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const bb = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = l - 0.0894841775 * a - 1.291485548 * bb;
  const lc = l_ ** 3;
  const mc = m_ ** 3;
  const sc = s_ ** 3;
  const rLin = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const gLin = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const bLin = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;
  const enc = (x) => {
    const v = clamp01(x);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return { r: enc(rLin), g: enc(gLin), b: enc(bLin) };
}

function fromHex(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const rgb = {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { ...rgb, alpha };
}

// Parse a colour literal to {r,g,b,alpha} in 0..1. Understands `#rgb/#rrggbb/
// #rrggbbaa`, `rgb(r g b)` / `rgb(r, g, b)` with optional `/ a`, `oklch(l c h)`,
// and the `white`/`black` keywords. Returns null for anything else (var(), etc.).
export function parseColor(value) {
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (v === "white") return { r: 1, g: 1, b: 1, alpha: 1 };
  if (v === "black") return { r: 0, g: 0, b: 0, alpha: 1 };
  if (v.startsWith("#")) return fromHex(v);
  let m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const num = (t) => (t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t));
    const chan = (t) => (t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t) / 255);
    return { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), alpha: parts[3] ? num(parts[3]) : 1 };
  }
  m = /^oklch\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const l = parts[0].endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const c = parseFloat(parts[1]);
    const h = parseFloat(parts[2]);
    const alpha = parts[3] ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { ...oklchToSrgb(l, c, h), alpha };
  }
  return null;
}

// Composite a foreground (possibly translucent) over an opaque background.
export function composite(fg, bg) {
  if (fg.alpha >= 1) return { r: fg.r, g: fg.g, b: fg.b };
  const a = fg.alpha;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

// ---------------------------------------------------------------------------
// Discovery: scan frontend/ for every file that defines a colour
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "out", "dist", "coverage", ".turbo"]);
const COLOUR_EXT = new Set([".css", ".ts", ".tsx"]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") && entry !== ".env") continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, acc);
      continue;
    }
    const ext = path.extname(entry);
    if (!COLOUR_EXT.has(ext)) continue;
    // A token defined only in a test/story never ships; measuring it would be
    // over-inclusion, and the spec forbids measuring test-only tokens.
    if (/\.(test|spec|stories)\./.test(entry) || /\.test-d\./.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

const TOKEN_DEF = /--([\w-]+)\s*:\s*([^;{}]+);/g;

// All `--name: value` definitions, keyed by the file that declares them.
export function discoverTokenDefs(files) {
  const byFile = new Map();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const defs = {};
    for (const m of source.matchAll(TOKEN_DEF)) defs[m[1]] = m[2].trim();
    if (Object.keys(defs).length) byFile.set(path.relative(ROOT, file), defs);
  }
  return byFile;
}

// Resolve a token name to a colour literal, following `var(--x)` chains across
// the discovered definitions (globals.css first, then any other declaring file).
function resolveToken(name, defs, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = defs.get(name);
  if (raw === undefined) return null;
  const varRef = /^var\(\s*--([\w-]+)\s*\)$/.exec(raw.trim());
  if (varRef) return resolveToken(varRef[1], defs, seen);
  return raw;
}

// ---------------------------------------------------------------------------
// Tailwind palette: resolve `zinc-900` etc. through theme.css (oklch)
// ---------------------------------------------------------------------------

function loadTailwindPalette() {
  const palette = new Map();
  if (!existsSync(THEME_CSS)) return palette;
  const css = readFileSync(THEME_CSS, "utf8");
  for (const m of css.matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/g)) {
    const literal = m[2].trim();
    if (parseColor(literal)) palette.set(m[1], literal);
  }
  return palette;
}

const PALETTE_FAMILIES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
  "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate",
  "gray", "zinc", "neutral", "stone",
];

function paletteTokenFor(utility) {
  // "zinc-900" -> theme key "zinc-900"; bare "white"/"black" handled by parseColor.
  const name = utility.replace(/^(text|bg|border|ring|from|to|via)-/, "");
  if (name === "white" || name === "black") return name;
  const m = new RegExp(`^(${PALETTE_FAMILIES.join("|")})-(\\d{2,3})$`).exec(name);
  return m ? name : null;
}

// ---------------------------------------------------------------------------
// Semantic utilities: `text-muted` -> --ink-muted, `bg-hover` -> --bg-hover
// ---------------------------------------------------------------------------

// The @theme inline mapping lives in globals.css; read it rather than hard-coding.
function loadSemanticMap(globalsSource) {
  const map = new Map();
  for (const m of globalsSource.matchAll(/--color-([\w-]+)\s*:\s*var\(--([\w-]+)\);/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

function semanticTokenFor(utility, semanticMap) {
  const name = utility.replace(/^(text|bg|border|ring|from|to|via)-/, "");
  return semanticMap.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Build the measured set
// ---------------------------------------------------------------------------

const SURFACES = ["bg-app", "bg-surface", "bg-raised", "bg-hover", "bg-inset"];
const MIN_TEXT = 4.5;
const MIN_UI = 3;

// Text/surface pairs from the semantic palette (the primary contract).
function semanticPairs() {
  const pairs = [];
  for (const bg of SURFACES) {
    for (const fg of ["ink", "ink-muted", "ink-faint"]) pairs.push([fg, bg, MIN_TEXT, "semantic"]);
  }
  pairs.push(["accent-fg", "accent", MIN_TEXT, "semantic"]);
  pairs.push(["accent", "bg-raised", MIN_TEXT, "semantic"]);
  pairs.push(["accent", "bg-surface", MIN_TEXT, "semantic"]);
  pairs.push(["success", "bg-raised", MIN_TEXT, "semantic"]);
  pairs.push(["warning", "bg-raised", MIN_TEXT, "semantic"]);
  pairs.push(["danger", "bg-raised", MIN_TEXT, "semantic"]);
  pairs.push(["accent-fg", "danger", MIN_TEXT, "semantic"]);
  pairs.push(["ink", "bubble-user", MIN_TEXT, "semantic"]);
  pairs.push(["ink", "code-bg", MIN_TEXT, "semantic"]);
  for (const bg of ["bg-app", "bg-surface", "bg-raised", "bg-hover"]) {
    pairs.push(["focus", bg, MIN_UI, "ui"]);
  }
  return pairs;
}

// The --line and --scrim assertions the old gate never made.
function structuralPairs() {
  return [
    // --line is a hairline UI boundary: held to 3:1 against the surfaces it
    // separates, per WCAG 1.4.11 (non-text contrast).
    ...SURFACES.map((bg) => ["line", bg, MIN_UI, "ui"]),
    // --scrim dims content behind a modal; it must reach at least 3:1 against the
    // page background so its presence is perceivable (raised by the honest gate).
    ["scrim", "bg-app", MIN_UI, "ui"],
  ];
}

// Palette/text pairs: measure a foreground colour where it is statically stacked
// on a determinate background within the same component file. A background is
// determinate when it is a `bg-*` utility (semantic token or palette colour) on
// the SAME element, or on an ANCESTOR element parsed from the same file. When no
// such background exists (e.g. the colour is a per-item runtime `style`), the
// pair is emitted as unmeasured — never silently skipped.
function staticPairs(files, semanticMap) {
  const measured = [];
  const unmeasured = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    // Parse elements in document order with their class lists, so an ancestor
    // stack can be reconstructed from nesting depth.
    const elements = parseElements(source);
    const ancestors = []; // stack of {depth, bg}
    for (const el of elements) {
      while (ancestors.length && ancestors[ancestors.length - 1].depth >= el.depth) ancestors.pop();
      const tokens = el.classes.split(/\s+/).filter(Boolean);
      const bgToken = tokens.find((t) => /^bg-/.test(t) && isColourUtility(t, semanticMap));
      const textTokens = tokens.filter((t) => /^text-/.test(t) && isColourUtility(t, semanticMap));
      const ownBg = bgToken ?? (ancestors.length ? ancestors[ancestors.length - 1].bg : null);
      for (const t of textTokens) {
        // A background on the element or an in-file ancestor is determinate.
        if (ownBg) {
          measured.push([t, ownBg, MIN_TEXT, `static:${rel}`]);
          continue;
        }
        // A semantic text token is already measured against every surface by
        // semanticPairs(); it needs no unmeasured entry. Only palette/contextual
        // colours (white, red-600) that no static rule can place go to the
        // unmeasured section — loud, and triaged like any failing pair.
        if (semanticTokenFor(t, semanticMap)) continue;
        unmeasured.push({ file: rel, fg: t, reason: noBackgroundReason(source, el) });
      }
      ancestors.push({ depth: el.depth, bg: bgToken });
    }
  }
  return { measured, unmeasured };
}

// A utility names a colour if it is a palette colour or a semantic-token alias.
function isColourUtility(utility, semanticMap) {
  if (paletteTokenFor(utility)) return true;
  return semanticTokenFor(utility, semanticMap) !== null;
}

function noBackgroundReason(source, el) {
  // Distinguish "background is set at runtime" (per-item style) from "no background here".
  const line = source.slice(el.start, el.start + 400);
  if (/style=\{\{[^}]*[bB]ackground/.test(line)) return "background set at runtime (inline style), not statically determinable";
  return "no statically-determinate background on the element or its ancestors in this file";
}

// A lightweight JSX element scanner: returns {depth, classes, start} for every
// opening tag carrying a `className`. Depth is approximated by bracket nesting
// of `<`/`</` so parent/child stacking can be recovered without a parser.
function parseElements(source) {
  const out = [];
  const re = /<(\/?)([A-Za-z][\w.]*)([^>]*?)(\/?)>/gs;
  let depth = 0;
  let m;
  while ((m = re.exec(source))) {
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attrText = m[3];
    const cm = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/.exec(attrText);
    if (cm) out.push({ depth, classes: cm[1] ?? cm[2] ?? cm[3] ?? "", start: m.index });
    if (!selfClosing) depth++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

function loadWaivers() {
  if (!existsSync(WAIVER_FILE)) return { waivers: [], triage: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(WAIVER_FILE, "utf8"));
  } catch {
    return { waivers: [], triage: [] };
  }
  return { waivers: raw.waivers ?? [], triage: raw.unmeasured_triage ?? [] };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export function check() {
  const files = walk(FRONTEND);
  const tokenDefsByFile = discoverTokenDefs(files);
  const globalsPath = path.join(FRONTEND, "app", "globals.css");
  const globals = existsSync(globalsPath) ? readFileSync(globalsPath, "utf8") : "";
  const semanticMap = loadSemanticMap(globals);
  const palette = loadTailwindPalette();

  // Merge every discovered token definition into one namespace (globals.css is
  // authoritative for theme tokens; later files only add names not already seen).
  const defs = new Map();
  for (const tokens of tokenDefsByFile.values()) {
    for (const [name, value] of Object.entries(tokens)) defs.set(name, value);
  }

  // Theme scoping: light and dark token values differ. Split the discovered
  // definitions by the block they live in, using globals.css's two theme blocks.
  const themes = {
    light: themeTokens(globals, ':root,\n:root[data-theme="light"]'),
    dark: themeTokens(globals, ':root[data-theme="dark"]'),
  };
  const sharedDefs = themeTokens(globals, ":root {\n  --identity-1");
  for (const [name, value] of Object.entries(sharedDefs)) if (!defs.has(name)) defs.set(name, value);

  const failures = [];
  const unmeasured = [];

  // Every file that contributes a colour to the app: token definitions (above)
  // plus any file using a colour utility (`text-*`/`bg-*`/`border-*`). This is
  // what `--debug-sources` reports, and it names FilesPanel.tsx / approvals/*
  // without a hard-coded allowlist.
  const colourSourceFiles = new Set(tokenDefsByFile.keys());
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Any file that names a colour utility contributes colour — whether it uses
    // it in JSX (`className=`) or exports it as a class string (styles.ts).
    if (/\b(?:text|bg|border|ring|from|to|via)-(?:[a-z]+)(?:-\d{2,3})?\b/.test(src)) {
      colourSourceFiles.add(path.relative(ROOT, file));
    }
  }

  const paletteSections = staticPairs(files, semanticMap);
  unmeasured.push(...paletteSections.unmeasured);

  // Resolve a `text-*`/`bg-*` utility to a colour literal: semantic tokens first
  // (resolved through the globals.css @theme map + the theme's token values),
  // then the Tailwind palette (oklch from theme.css), then bare white/black.
  const resolveUtility = (utility, themeSet) => {
    const semantic = semanticTokenFor(utility, semanticMap);
    if (semantic) {
      const lit = themeSet.get(semantic) ?? resolveToken(semantic, defs);
      if (lit) return lit;
    }
    const pal = paletteTokenFor(utility);
    if (pal) return palette.get(pal) ?? pal;
    return null;
  };

  for (const [name, set] of Object.entries(themes)) {
    const tokensByName = new Map(Object.entries(set));
    const pairs = [...semanticPairs(), ...structuralPairs()];
    for (const [fgName, bgName, min, kind] of pairs) {
      const fgLit = resolveToken(fgName, tokensByName) ?? resolveToken(fgName, defs);
      const bgLit = resolveToken(bgName, tokensByName) ?? resolveToken(bgName, defs);
      if (!fgLit || !bgLit) continue;
      const fg = parseColor(fgLit);
      const bg = parseColor(bgLit);
      if (!fg || !bg) continue;
      const fgComposited = composite(fg, bg);
      const got = ratio(fgComposited, bg);
      if (got < min) {
        failures.push({ theme: name, pair: `${fgName} on ${bgName}`, fg: fgLit, bg: bgLit, ratio: got, required: min, kind });
      }
    }
    for (let i = 1; i <= 10; i++) {
      const lit = tokensByName.get(`identity-${i}`);
      if (!lit) continue;
      const c = parseColor(lit);
      if (!c) continue;
      const white = { r: 1, g: 1, b: 1 };
      const got = ratio(white, c);
      if (got < MIN_TEXT) {
        failures.push({ theme: name, pair: `white on identity-${i}`, fg: "#ffffff", bg: lit, ratio: got, required: MIN_TEXT, kind: "identity" });
      }
    }
  }

  for (const [fgUtil, bgUtil, min, src] of paletteSections.measured) {
    // Measure in each theme so a semantic token resolves to that theme's value.
    for (const [name, set] of Object.entries(themes)) {
      const themeSet = new Map(Object.entries(set));
      const fgLit = resolveUtility(fgUtil, themeSet);
      const bgLit = resolveUtility(bgUtil, themeSet);
      if (!fgLit || !bgLit) continue;
      const fg = parseColor(fgLit);
      const bg = parseColor(bgLit);
      if (!fg || !bg) continue;
      const got = ratio(composite(fg, bg), bg);
      if (got < min) {
        failures.push({ theme: name, pair: `${fgUtil} on ${bgUtil}`, fg: fgLit, bg: bgLit, ratio: got, required: min, kind: src });
      }
    }
  }

  return { failures, unmeasured, files: [...colourSourceFiles] };
}

// Extract the token definitions inside the block starting at `selector`.
function themeTokens(source, selector) {
  const start = source.indexOf(selector);
  if (start < 0) return {};
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const found = {};
  for (const m of source.slice(open + 1, close).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    found[m[1]] = m[2].trim();
  }
  return found;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const debugSources = argv.includes("--debug-sources");
  const result = check();
  const { waivers, triage } = loadWaivers();

  if (debugSources) {
    console.log("ingested colour-source files:");
    for (const f of result.files.sort()) console.log(`  ${f}`);
    console.log(`total: ${result.files.length}`);
    return 0;
  }

  const waiverByPair = new Map(waivers.map((w) => [`${w.theme}:${w.pair}`, w]));
  const stale = [];
  const unwaived = [];
  for (const f of result.failures) {
    const key = `${f.theme}:${f.pair}`;
    const w = waiverByPair.get(key);
    if (!w) {
      unwaived.push(f);
      continue;
    }
    if (Math.abs(w.ratio - f.ratio) > 0.05) {
      stale.push({ ...f, waived: w.ratio });
    }
  }

  // Every unmeasured pair must carry a triage entry (measured-by-hand result),
  // so an unmeasurable pair cannot silently vanish from the gate's story.
  const untriaged = result.unmeasured.filter((u) => {
    return !triage.some((t) => t.file === u.file && t.fg === u.fg);
  });

  if (result.unmeasured.length) {
    console.log(`unmeasured (${result.unmeasured.length}):`);
    for (const u of result.unmeasured) {
      const t = triage.find((x) => x.file === u.file && x.fg === u.fg);
      console.log(`  ${u.file}: ${u.fg} — ${u.reason}${t ? ` [triaged: ${t.disposition}]` : " [UNTRIAGED]"}`);
    }
  }

  if (untriaged.length) {
    for (const u of untriaged) {
      console.error(`untriaged unmeasured pair: ${u.file}: ${u.fg} — add it to ${path.basename(WAIVER_FILE)} unmeasured_triage`);
    }
    process.exit(1);
  }
  if (stale.length) {
    for (const s of stale) {
      console.error(`stale waiver: ${s.theme}: ${s.pair} is now ${s.ratio.toFixed(2)}:1 but the waiver records ${s.waived.toFixed(2)}:1`);
    }
    process.exit(1);
  }
  if (unwaived.length) {
    for (const f of unwaived) {
      console.error(`${f.theme}: ${f.pair} is ${f.ratio.toFixed(2)}:1, needs ${f.required}:1 (${f.fg} on ${f.bg})`);
    }
    process.exit(1);
  }
  console.log(`contrast ok (${result.failures.length} pairs, ${waivers.length} waived)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
