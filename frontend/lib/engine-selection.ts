import type { Engine } from "./api";

export type EngineChoice = {
  provider: string;
  model: string | null;
};

export const PREFERRED_ENGINE_STORAGE_KEY = "open_duet_preferred_engine";

/**
 * Resolves the engine and model to start on when creating a new chat or loading the app.
 * Follows OpenBot's resolveCreationModel pattern:
 * 1. Checks if the saved disk/cached preference is available and ready in the live engine catalog.
 * 2. If so, uses that provider and verifies if the model is valid (or falls back to the engine's default model).
 * 3. If the saved preference is unavailable or not signed in, finds the first available/ready engine.
 * 4. If no engines are ready, falls back to the preferred provider or first engine in the list.
 */
export function resolveEngineModel(
  saved: { provider: string | null; model: string | null } | null,
  engines: Engine[] | null
): EngineChoice {
  const preferredProvider = saved?.provider?.trim() || null;
  const preferredModel = saved?.model?.trim() || null;

  if (!engines || engines.length === 0) {
    return {
      provider: preferredProvider ?? "claude",
      model: preferredModel,
    };
  }

  // 1. If preferred provider exists and is available:
  if (preferredProvider) {
    const engine = engines.find((e) => e.id === preferredProvider);
    if (engine && engine.available) {
      const modelValid =
        preferredModel &&
        (engine.custom_models || engine.models.some((m) => m.id === preferredModel));
      const model = modelValid
        ? preferredModel
        : engine.default_model ?? engine.models[0]?.id ?? null;
      return { provider: engine.id, model };
    }
  }

  // 2. Preferred provider is missing or unavailable: pick the first available/ready engine
  const readyEngine = engines.find((e) => e.available);
  if (readyEngine) {
    return {
      provider: readyEngine.id,
      model: readyEngine.default_model ?? readyEngine.models[0]?.id ?? null,
    };
  }

  // 3. Fallback when no engine is marked available: keep the preferred provider if listed, or first
  const fallback = engines.find((e) => e.id === preferredProvider) ?? engines[0];
  return {
    provider: fallback.id,
    model: fallback.default_model ?? fallback.models[0]?.id ?? null,
  };
}

/**
 * Reads the cached engine preference from localStorage for instant 0ms hydration.
 */
export function readCachedPreference(
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null
): { provider: string | null; model: string | null } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFERRED_ENGINE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : null;
      const model = typeof parsed.model === "string" ? parsed.model.trim() : null;
      return { provider: provider || null, model: model || null };
    }
  } catch {
    // storage broken or blocked
  }
  return null;
}

/**
 * Writes the cached engine preference to localStorage.
 */
export function writeCachedPreference(
  choice: { provider: string | null; model: string | null },
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null
): void {
  if (!storage) return;
  try {
    storage.setItem(
      PREFERRED_ENGINE_STORAGE_KEY,
      JSON.stringify({
        provider: choice.provider?.trim() || null,
        model: choice.model?.trim() || null,
      })
    );
  } catch {
    // storage blocked
  }
}