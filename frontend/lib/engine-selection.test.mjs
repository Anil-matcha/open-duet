import test from "node:test";
import assert from "node:assert/strict";
import { resolveEngineModel, readCachedPreference, writeCachedPreference, PREFERRED_ENGINE_STORAGE_KEY } from "./engine-selection.ts";

const mockEngines = [
  {
    id: "claude",
    label: "Claude",
    available: false,
    reason: "Claude is not installed",
    models: [{ id: "claude-sonnet-4-5", label: "Sonnet 4.5", default: true }],
    default_model: "claude-sonnet-4-5",
    custom_models: false,
  },
  {
    id: "antigravity",
    label: "Google Gemini (Antigravity)",
    available: true,
    reason: null,
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", default: true },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", default: false },
    ],
    default_model: "gemini-2.5-pro",
    custom_models: true,
  },
  {
    id: "codex",
    label: "Codex",
    available: false,
    reason: "Codex not signed in",
    models: [{ id: "o3-mini", label: "o3-mini", default: true }],
    default_model: "o3-mini",
    custom_models: false,
  },
];

test("resolves saved provider and model when available", () => {
  const resolved = resolveEngineModel(
    { provider: "antigravity", model: "gemini-2.5-flash" },
    mockEngines
  );
  assert.deepEqual(resolved, {
    provider: "antigravity",
    model: "gemini-2.5-flash",
  });
});

test("falls back to engine default model if saved model is empty", () => {
  const resolved = resolveEngineModel(
    { provider: "antigravity", model: null },
    mockEngines
  );
  assert.deepEqual(resolved, {
    provider: "antigravity",
    model: "gemini-2.5-pro",
  });
});

test("auto-selects first available engine when preferred engine (e.g. Claude) is unavailable", () => {
  // User had default "claude", but Claude is not available, while Antigravity is available
  const resolved = resolveEngineModel(
    { provider: "claude", model: null },
    mockEngines
  );
  assert.deepEqual(resolved, {
    provider: "antigravity",
    model: "gemini-2.5-pro",
  });
});

test("auto-selects first available engine when no preference is saved", () => {
  const resolved = resolveEngineModel(null, mockEngines);
  assert.deepEqual(resolved, {
    provider: "antigravity",
    model: "gemini-2.5-pro",
  });
});

test("falls back cleanly when no engines list is loaded yet", () => {
  const resolved = resolveEngineModel({ provider: "antigravity", model: "gemini-2.5-pro" }, null);
  assert.deepEqual(resolved, {
    provider: "antigravity",
    model: "gemini-2.5-pro",
  });
});

test("cached preference read and write in localStorage", () => {
  const store = {};
  const mockStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = String(val); },
  };

  assert.equal(readCachedPreference(mockStorage), null);

  writeCachedPreference({ provider: "antigravity", model: "gemini-2.5-pro" }, mockStorage);
  assert.deepEqual(readCachedPreference(mockStorage), {
    provider: "antigravity",
    model: "gemini-2.5-pro",
  });
});

