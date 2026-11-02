import test from "node:test";
import assert from "node:assert/strict";
import { resolveEngineModel, readCachedPreference, writeCachedPreference } from "./engine-selection.ts";

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


test("resolves reasoning effort when model supports configurable effort", () => {
  const enginesWithEffort = [
    {
      id: "antigravity",
      label: "Google Gemini",
      available: true,
      default_model: "gemini-3.8-flash",
      models: [
        {
          id: "gemini-3.8-flash",
          label: "Gemini 3.8 Flash",
          default: true,
          default_reasoning_effort: "medium",
          supported_reasoning_efforts: ["low", "medium", "high"],
          reasoning_effort_configurable: true,
        },
        {
          id: "gpt-oss-120b",
          label: "GPT-OSS 120B (Medium)",
          default: false,
          supported_reasoning_efforts: [],
          reasoning_effort_configurable: false,
        },
      ],
    },
  ];

  // 1. No effort saved -> picks model default reasoning effort
  const resDefault = resolveEngineModel({ provider: "antigravity", model: "gemini-3.8-flash" }, enginesWithEffort);
  assert.deepEqual(resDefault, {
    provider: "antigravity",
    model: "gemini-3.8-flash",
    effort: "medium",
  });

  // 2. Saved effort is valid -> preserves saved effort
  const resHigh = resolveEngineModel({ provider: "antigravity", model: "gemini-3.8-flash", effort: "high" }, enginesWithEffort);
  assert.deepEqual(resHigh, {
    provider: "antigravity",
    model: "gemini-3.8-flash",
    effort: "high",
  });

  // 3. Model without configurable effort -> no effort returned
  const resFixed = resolveEngineModel({ provider: "antigravity", model: "gpt-oss-120b", effort: "high" }, enginesWithEffort);
  assert.deepEqual(resFixed, {
    provider: "antigravity",
    model: "gpt-oss-120b",
  });
});

test("cached preference read and write with effort in localStorage", () => {
  const store = {};
  const mockStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = String(val); },
  };

  writeCachedPreference({ provider: "antigravity", model: "gemini-3.8-flash", effort: "high" }, mockStorage);
  assert.deepEqual(readCachedPreference(mockStorage), {
    provider: "antigravity",
    model: "gemini-3.8-flash",
    effort: "high",
  });
});
