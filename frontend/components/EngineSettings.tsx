"use client";

import { useEffect, useState } from "react";
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


export function EngineSettings({ onEnginesChanged }: { onEnginesChanged?: (engines: Engine[]) => void } = {}) {
  const [desktop, setDesktop] = useState(false);
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>("refresh");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getEngines(refresh > 0).then((items) => {
      if (cancelled) return;
      setEngines(items);
      setDesktop(!!window.openDots);
      onEnginesChanged?.(items);
      setDrafts((previous) => ({ ...Object.fromEntries(items.map((item) => [item.id, engineDraft(item)])), ...previous }));
      setError(null);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof ApiError ? `Could not load engines. Check that the backend is running. ${err.message}` : "Could not load engines. Check that the backend is running.");
    }).finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [refresh, onEnginesChanged]);

  const save = async (engine: Engine) => {
    const draft = drafts[engine.id];
    if (!draft) return;
    setBusy(engine.id); setError(null);
    try {
      const saved = await api.saveEngineConfig(engine.id, engineConfig(engine, draft));
      const updated = engines?.map((item) => item.id === engine.id ? saved : item) ?? [];
      setEngines(updated);
      onEnginesChanged?.(updated);
      setDrafts((previous) => ({ ...previous, [engine.id]: engineDraft(saved) }));
      toast(`${engine.label} settings saved. ${saved.available ? "Ready to use." : saved.reason ?? "The engine is not ready yet."}`);
    } catch (err) { setError(err instanceof ApiError ? `Could not save engine settings. ${err.message}` : "Could not save engine settings."); }
    finally { setBusy(null); }
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
    return <label key={descriptor.name} className="block min-w-0 text-xs text-muted">{descriptor.label}{hasSecret ? " (saved; leave empty to keep)" : descriptor.required ? "" : " (optional)"}
      {engine.id === "antigravity" && descriptor.name === "model" ? <Select className="mt-1" value={drafts[engine.id]?.model ?? ""}
 onChange={(event) => setDrafts((old) => ({ ...old, [engine.id]: { ...old[engine.id], model: event.target.value } }))}>
        <option value="">Account default</option>{engine.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </Select> : <Input className="mt-1" type={descriptor.kind === "secret" ? "password" : descriptor.kind === "url" ? "url" : "text"}
 required={descriptor.required && !hasSecret} value={drafts[engine.id]?.[descriptor.name] ?? ""}
 placeholder={descriptor.placeholder ?? undefined} autoComplete={descriptor.kind === "secret" ? "new-password" : "off"}
 onChange={(event) => setDrafts((old) => ({ ...old, [engine.id]: { ...old[engine.id], [descriptor.name]: event.target.value } }))} />}
      {descriptor.help && <span className="mt-1 block">{descriptor.help}</span>}
    </label>;
  };

  return <section className="space-y-4 rounded-lg border border-line p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Engines</h3><p className="mt-1 text-xs text-muted">Connect an AI, then choose it for an agent or conversation.</p></div><Button disabled={busy !== null} onClick={() => { setBusy("refresh"); setRefresh((n) => n + 1); }}>{busy === "refresh" ? "Checking…" : "Check again"}</Button></div>
    {error && <Banner tone="danger">{error}</Banner>}
    {!engines && !error && <SkeletonList rows={3} />}
    {engineGroups(engines ?? []).map((group) => <div key={group.label} className="space-y-3"><h4 className="text-sm font-semibold">{group.label}</h4>{group.engines.map((engine) => {
      const fields = engine.config_fields ?? [];
      return <article key={engine.id} className="min-w-0 space-y-3 rounded-md border border-line p-4">
        <div className="flex flex-wrap items-center gap-2"><h5 className="font-medium">{engine.label}</h5><span className={`rounded px-2 py-0.5 text-xs ${engine.available ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{engine.available ? "Ready" : "Needs setup"}</span>{engine.version && <span className="text-xs text-muted">{engine.version}</span>}</div>
        {!engine.available && <p className="break-words text-xs text-muted">{engine.reason}</p>}
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
        {engine.configurable && fields.length > 0 && <form onSubmit={(event) => { event.preventDefault(); void save(engine); }}><fieldset disabled={busy !== null} className="space-y-3">
          {fields.some((item) => item.name === "base_url") && <label className="block text-xs text-muted">Fill address from template<Select className="mt-1" value="" onChange={(event) => setDrafts((old) => ({ ...old, [engine.id]: { ...old[engine.id], base_url: event.target.value } }))}><option value="">Choose a service…</option>{ENDPOINT_TEMPLATES.map((template) => <option key={template.label} value={template.url}>{template.label}</option>)}</Select></label>}
          <div className="grid gap-3 sm:grid-cols-2">{fields.filter((item) => !item.advanced).map((item) => field(engine, item))}</div>
          {fields.some((item) => item.advanced) && <details><summary className="cursor-pointer text-sm">Advanced</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{fields.filter((item) => item.advanced).map((item) => field(engine, item))}</div></details>}
          <div className="flex flex-wrap gap-2"><Button type="submit">{busy === engine.id ? "Saving…" : "Save engine"}</Button>{engine.config && engine.id !== "antigravity" && <Button type="button" onClick={() => void forget(engine)}>Forget settings</Button>}</div>
        </fieldset></form>}
      </article>;
    })}</div>)}
  </section>;
}
