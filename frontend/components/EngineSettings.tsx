"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Engine, type EngineConfigField } from "@/lib/api";
import { ENDPOINT_TEMPLATES, engineConfig, engineDraft, engineGroups } from "@/lib/engines";
import { ClaudeEngineSetup } from "./ClaudeEngineSetup";
import { CodexEngineSetup } from "./CodexEngineSetup";
import { GoogleEngineSetup } from "./GoogleEngineSetup";
import { EngineInstall } from "./EngineInstall";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Banner } from "@/components/ui/Banner";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { readCachedPreference, resolveEngineModel, writeCachedPreference } from "@/lib/engine-selection";
import { Applies } from "@/components/settings/Applies";
import { SaveBar } from "@/components/settings/SaveBar";
import { SavedConfirmation, useSavedConfirmation } from "@/components/settings/SavedConfirmation";
import { cn } from "@/lib/cn";

function initialExpandedEngines(engines: Engine[], preferredId: string | null): Set<string> {
  const activeId = resolveEngineModel({ provider: preferredId, model: null }, engines).provider;
  const active = engines.find((engine) => engine.id === activeId) ?? engines[0];
  const expanded = new Set<string>();
  if (active) expanded.add(active.id);
  // Keep the active engine and up to two setup choices open on first paint.
  for (const engine of engines) {
    if (expanded.size >= 3) break;
    if (!engine.available) expanded.add(engine.id);
  }
  return expanded;
}


export function EngineSettings({ onEnginesChanged }: { onEnginesChanged?: (engines: Engine[]) => void } = {}) {
  const [desktop, setDesktop] = useState(false);
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [engineErrors, setEngineErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  const confirmation = useSavedConfirmation();
  const [busy, setBusy] = useState<string | null>("refresh");
  const [refresh, setRefresh] = useState(0);
  const [expandedEngines, setExpandedEngines] = useState<Set<string> | null>(null);
  const preferredEngine = useRef<string | null>(readCachedPreference()?.provider ?? null);
  const engineList = useRef<Engine[] | null>(null);
  const userChangedExpansion = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.getEngines(refresh > 0).then((items) => {
      if (cancelled) return;
      setEngines(items);
      engineList.current = items;
      if (!userChangedExpansion.current) setExpandedEngines(initialExpandedEngines(items, preferredEngine.current));
      setDesktop(!!window.openDots);
      onEnginesChanged?.(items);
      setDrafts((previous) => ({ ...Object.fromEntries(items.map((item) => [item.id, engineDraft(item)])), ...previous }));
      setError(null);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? `Could not load engines. Check that the backend is running. ${err.message}` : "Could not load engines. Check that the backend is running.");
    }).finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [refresh, onEnginesChanged]);

  useEffect(() => {
    let cancelled = false;
    api.getEnginePreference().then((preference) => {
      if (!cancelled && preference?.provider) {
        preferredEngine.current = preference.provider;
        writeCachedPreference({ provider: preference.provider, model: preference.model, effort: preference.effort });
        const eff = preference.effort;
        if (typeof eff === "string" && eff) {
          const prov = preference.provider;
          setDrafts((prev) => ({
            ...prev,
            [prov]: {
              ...(prev[prov] ?? {}),
              effort: eff,
            },
          }));
        }
        if (engineList.current && !userChangedExpansion.current) {
          setExpandedEngines(initialExpandedEngines(engineList.current, preference.provider));
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const persistEngineConfig = async (
    engine: Engine,
    config: ReturnType<typeof engineConfig>,
    preferenceModel?: string,
    instantField?: { name: string; value: string },
  ) => {
    setBusy(engine.id); setError(null);
    setEngineErrors((previous) => ({ ...previous, [engine.id]: "" }));
    try {
      const saved = await api.saveEngineConfig(engine.id, config);
      const updated = engines?.map((item) => item.id === engine.id ? saved : item) ?? [];
      setEngines(updated);
      if (saved.available) preferredEngine.current = saved.id;
      onEnginesChanged?.(updated);
      setDrafts((previous) => ({
        ...previous,
        [engine.id]: instantField
          ? { ...engineDraft(saved), ...previous[engine.id], [instantField.name]: instantField.value }
          : engineDraft(saved),
      }));
      confirmation.showSaved(engine.id);
      toast(`${engine.label} settings saved. ${saved.available ? "Ready to use." : saved.reason ?? "The engine is not ready yet."}`);
      if (saved.available) {
        const prefModel = preferenceModel?.trim() || saved.default_model || null;
        const prefEffort = instantField?.name === "effort" ? instantField.value : (drafts[saved.id]?.effort ?? null);
        writeCachedPreference({ provider: saved.id, model: prefModel, effort: prefEffort });
        void api.setEnginePreference({ provider: saved.id, model: prefModel, effort: prefEffort }).catch(() => {});
      }
    } catch (err) { setEngineErrors((previous) => ({ ...previous, [engine.id]: err instanceof ApiError ? `Could not save engine settings. ${err.message}` : "Could not save engine settings." })); }
    finally { setBusy(null); }
  };

  const save = async (engine: Engine) => {
    const draft = drafts[engine.id];
    if (draft) await persistEngineConfig(engine, engineConfig(engine, draft), draft.model);
  };

  const saveEngineField = async (engine: Engine, name: string, value: string) => {
    const next = { ...engineDraft(engine), ...drafts[engine.id], [name]: value };
    setDrafts((previous) => ({ ...previous, [engine.id]: { ...previous[engine.id], [name]: value } }));
    confirmation.clearSaved(engine.id);
    await persistEngineConfig(engine, engineConfig(engine, next), next.model, { name, value });
  };

  const forget = async (engine: Engine) => {
    setBusy(engine.id); setError(null);
    try {
      await api.deleteEngineConfig(engine.id);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[engine.id];
        return next;
      });
      setRefresh((n) => n + 1);
      toast(`${engine.label} settings and saved credential removed.`);
    } catch (err) { setError(err instanceof ApiError ? `Could not remove engine settings. ${err.message}` : "Could not remove engine settings."); }
    finally { setBusy(null); }
  };

  const field = (engine: Engine, descriptor: EngineConfigField) => {
    const hasSecret = descriptor.kind === "secret" && engine.config?.[`has_${descriptor.name}`] === true;
    const updateDraft = (name: string, value: string) => {
      setDrafts((old) => ({ ...old, [engine.id]: { ...old[engine.id], [name]: value } }));
      setEngineErrors((old) => ({ ...old, [engine.id]: "" }));
      confirmation.clearSaved(engine.id);
    };
    const settingId = descriptor.kind === "secret" ? "setting-engine-api-key" : descriptor.name === "model" ? "setting-engine-endpoint" : undefined;
    const activeModelId = drafts[engine.id]?.model || engine.default_model || engine.models[0]?.id;
    const currentModelObj = engine.models.find((m) => m.id === activeModelId);
    const supportsEffort = Boolean(
      descriptor.name === "model" &&
      currentModelObj?.supported_reasoning_efforts &&
      currentModelObj.supported_reasoning_efforts.length > 1 &&
      currentModelObj.reasoning_effort_configurable !== false
    );

    return <div key={descriptor.name} data-setting-id={settingId} className="block min-w-0 text-xs text-muted">
      <label className="block">{descriptor.label}{hasSecret ? " (saved; leave empty to keep)" : descriptor.required ? "" : " (optional)"}
        {descriptor.name === "model" && engine.models.length > 0 ? <Select className="mt-1" value={drafts[engine.id]?.model ?? ""}
   onChange={(event) => void saveEngineField(engine, "model", event.target.value)}>
          <option value="">{engine.id === "antigravity" ? "Account default" : "Engine default"}</option>{engine.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </Select> : <Input className="mt-1" type={descriptor.kind === "secret" ? "password" : descriptor.kind === "url" ? "url" : "text"}
   required={descriptor.required && !hasSecret} value={drafts[engine.id]?.[descriptor.name] ?? ""}
   placeholder={descriptor.placeholder ?? undefined} autoComplete={descriptor.kind === "secret" ? "new-password" : "off"}
   onChange={(event) => updateDraft(descriptor.name, event.target.value)} />}
        {descriptor.help && <span className="mt-1 block">{descriptor.help}</span>}
      </label>
      {supportsEffort && currentModelObj?.supported_reasoning_efforts && (
        <div className="pt-2">
          <span className="block text-xs font-medium text-muted mb-1">Reasoning effort</span>
          <div className="inline-flex rounded-lg bg-inset p-1 border border-line gap-1">
            {currentModelObj.supported_reasoning_efforts.map((eff) => {
              const currentEffort = drafts[engine.id]?.effort ?? currentModelObj.default_reasoning_effort;
              const isSelected = currentEffort?.toLowerCase() === eff.toLowerCase();
              return (
                <button
                  key={eff}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void saveEngineField(engine, "effort", eff)}
                  className={cn(
                    "px-3 py-1 text-xs rounded-md font-medium capitalize transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
                    isSelected
                      ? "bg-raised text-ink shadow-sm ring-1 ring-line/50 font-semibold"
                      : "text-muted hover:text-ink hover:bg-hover/50"
                  )}
                >
                  {eff}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>;
  };

  return <section className="space-y-4 rounded-lg border border-line p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Engines</h3><p className="mt-1 text-xs text-muted">Connect an AI, then choose it for an agent or conversation.</p></div><Button disabled={busy !== null} onClick={() => { setBusy("refresh"); setRefresh((n) => n + 1); }}>{busy === "refresh" ? "Checking…" : "Check again"}</Button></div>
    {error && <Banner tone="danger">{error}</Banner>}
    {!engines && !error && <SkeletonList rows={3} />}
    {engineGroups(engines ?? []).map((group) => <div key={group.label} className="space-y-3"><h4 className="text-sm font-semibold">{group.label}</h4>{group.engines.map((engine) => {
      const fields = engine.config_fields ?? [];
      const settingAnchors = [
        engine.configurable && fields.some((item) => item.kind === "secret") ? "setting-engine-api-key" : null,
        engine.configurable && fields.some((item) => item.name === "base_url" || item.name === "model") ? "setting-engine-endpoint" : null,
      ].filter((anchor): anchor is string => anchor !== null).join(" ");
      const expanded = expandedEngines?.has(engine.id) ?? false;
      const formId = `engine-config-${engine.id}`;
      const draft = drafts[engine.id] ?? engineDraft(engine);
      const dirty = JSON.stringify(draft) !== JSON.stringify(engineDraft(engine));
      return <article key={engine.id} className="min-w-0 rounded-md border border-line p-4">
        <button
          type="button"
          data-setting-expand-for={settingAnchors || undefined}
          className="flex w-full flex-wrap items-center gap-2 text-left"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${engine.label} settings`}
          onClick={() => {
            userChangedExpansion.current = true;
            setExpandedEngines((current) => {
              const next = new Set(current ?? []);
              if (next.has(engine.id)) next.delete(engine.id);
              else next.add(engine.id);
              return next;
            });
          }}
        >
          <span className="font-medium">{engine.label}</span><span className={`rounded px-2 py-0.5 text-xs ${engine.available ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{engine.available ? "Ready" : "Needs setup"}</span>{engine.version && <span className="text-xs text-muted">{engine.version}</span>}
          <span className="ml-auto text-xs text-muted">{expanded ? "Collapse" : "Expand"}</span>
        </button>
        {!engine.available && <p className="mt-2 break-words text-xs text-muted">{engine.reason}</p>}
        {expanded && <div className="mt-3 space-y-3">
        {engine.id === "claude" && engine.installed && <ClaudeEngineSetup signedIn={engine.signed_in} onChanged={() => setRefresh((n) => n + 1)} />}
        {engine.id === "codex" && engine.installed && <CodexEngineSetup signedIn={engine.signed_in} onChanged={() => setRefresh((n) => n + 1)} />}
        {engine.id === "antigravity" && <GoogleEngineSetup engine={engine} onChanged={() => {
          setDrafts((previous) => { const next = { ...previous }; delete next.antigravity; return next; });
          setRefresh((n) => n + 1);
        }} />}
        {desktop && (engine.id === "claude" || engine.id === "codex" || engine.id === "opencode") && <EngineInstall engine={engine.id} installed={engine.installed === true} onChanged={() => setRefresh(value => value + 1)} />}
        {engine.setup && <div className="space-y-1 text-xs text-muted">
          {engine.setup.install && <p>Install: <code className="break-all">{engine.setup.install}</code></p>}
          {engine.setup.sign_in && <p>Sign in: <code className="break-all">{engine.setup.sign_in}</code></p>}
          {engine.setup.notes?.map((note) => <p key={note}>{note}</p>)}
          {engine.setup.docs_url && <a className="inline-block underline" href={engine.setup.docs_url} target="_blank" rel="noreferrer">Connection guide</a>}
        </div>}
        <p className="text-xs text-muted">{engine.models.length} model suggestions{engine.custom_models ? " · custom model IDs accepted" : ""}</p>
        {engine.configurable && fields.length > 0 && <form id={formId} onSubmit={(event) => { event.preventDefault(); void save(engine); }}><fieldset disabled={busy !== null} className="space-y-3">
          {fields.some((item) => item.name === "base_url") && <label className="block text-xs text-muted">Fill address from template<Select className="mt-1" value="" onChange={(event) => void saveEngineField(engine, "base_url", event.target.value)}><option value="">Choose a service…</option>{ENDPOINT_TEMPLATES.map((template) => <option key={template.label} value={template.url}>{template.label}</option>)}</Select></label>}
          <div className="grid gap-3 sm:grid-cols-2">{fields.filter((item) => !item.advanced).map((item) => field(engine, item))}</div>
          {fields.some((item) => item.advanced) && <details><summary className="cursor-pointer text-sm">Advanced</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{fields.filter((item) => item.advanced).map((item) => field(engine, item))}</div></details>}
          <div className="flex flex-wrap items-center gap-2"><Applies when="next turn" /><SavedConfirmation visible={confirmation.saved.has(engine.id) && dirty} /></div>
          <SaveBar dirty={dirty} saving={busy === engine.id} error={engineErrors[engine.id] || null} saved={confirmation.saved.has(engine.id)} saveLabel="Save engine" onSave={() => {
            const form = document.getElementById(formId);
            if (form instanceof HTMLFormElement) form.requestSubmit();
          }} onDiscard={() => { setDrafts((previous) => ({ ...previous, [engine.id]: engineDraft(engine) })); setEngineErrors((previous) => ({ ...previous, [engine.id]: "" })); confirmation.clearSaved(engine.id); }} />
          {engine.config && engine.id !== "antigravity" && <Button type="button" onClick={() => void forget(engine)}>Forget settings</Button>}
        </fieldset></form>}
        </div>}
      </article>;
    })}</div>)}
  </section>;
}
