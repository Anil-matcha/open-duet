// The engines a server has (Claude, Codex, ...) and the models each offers, as the agent editor lists them.
// Read tolerantly: only what the editor needs is named, unknown fields are ignored and a malformed entry is dropped.

export type EngineModel = { id: string; label: string; isDefault: boolean };

export type Engine = {
  id: string;
  label: string;
  /** Installed and signed in, so a conversation can run on it. */
  available: boolean;
  /** Why it is not available, when the server says. */
  reason: string | null;
  models: EngineModel[];
  defaultModel: string | null;
  /** The engine takes any model id, not just the listed ones. */
  customModels: boolean;
  /** Agent computers; an agent with one cannot move to an engine without this. */
  computers: boolean;
  /** Set while the engine refuses turns for a usage or rate limit or no credits. */
  limit: string | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function readEngines(body: unknown): Engine[] {
  if (!Array.isArray(body)) return [];
  const engines: Engine[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = text(record.id);
    if (!id) continue;
    const models: EngineModel[] = [];
    if (Array.isArray(record.models)) {
      for (const model of record.models) {
        const m = model as Record<string, unknown> | null;
        const modelId = text(m?.id);
        if (modelId) models.push({ id: modelId, label: text(m?.label) ?? modelId, isDefault: m?.default === true });
      }
    }
    const capabilities = (record.capabilities ?? {}) as Record<string, unknown>;
    const limit = (record.limit ?? null) as Record<string, unknown> | null;
    engines.push({
      id,
      label: text(record.label) ?? id,
      available: record.available === true,
      reason: text(record.reason),
      models,
      defaultModel: text(record.default_model),
      customModels: record.custom_models === true,
      computers: capabilities.computers === true,
      limit: text(limit?.message),
    });
  }
  return engines;
}

export function findEngine(engines: Engine[], id: string): Engine | undefined {
  return engines.find((engine) => engine.id === id);
}

/** The label to show for an engine id, falling back to the id for one this server no longer lists. */
export function engineLabel(engines: Engine[], id: string): string {
  return findEngine(engines, id)?.label ?? id;
}

/** "Engine default (name)" for no model, the model's label, or the id with a note for one the engine no longer lists. */
export function modelLabel(engine: Engine | undefined, model: string | null): string {
  if (model === null) {
    const fallback = engine?.models.find((m) => m.id === engine.defaultModel) ?? engine?.models.find((m) => m.isDefault);
    return fallback ? `Engine default (${fallback.label})` : 'Engine default';
  }
  const known = engine?.models.find((m) => m.id === model);
  if (known) return known.label;
  return engine && !engine.customModels ? `${model} (saved; unavailable)` : model;
}

/** The note beside an engine that cannot be chosen, as on the web: "Needs setup", or why. */
export function engineProblem(engine: Engine): string | null {
  if (!engine.available) return engine.reason ?? 'Needs setup';
  return engine.limit;
}
