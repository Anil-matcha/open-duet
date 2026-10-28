"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Engine } from "@/lib/api";
import { firstReadyEngine } from "@/lib/engines";
import { onboarding, onboardingChatHref, STARTER_ROLES, type OnboardingDraft, type OnboardingState } from "@/lib/onboarding";
import { EngineSettings } from "./EngineSettings";
import { EngineModelFields } from "./chat/EngineModelFields";
import { DesktopPermissions } from "./DesktopPermissions";
import { ThemeToggle } from "./ui/ThemeToggle";

const STEPS = ["Welcome", "Connect an AI", "Your first agent", "Ready"];
const FIELD = "mt-1 w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm";
const BUTTON = "rounded-md border border-line px-4 py-2 text-sm disabled:opacity-50";

export function OnboardingApp() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [lastSaved, setLastSaved] = useState("");

  useEffect(() => {
    let live = true;
    onboarding.get().then(value => {
      if (!live) return;
      setState(value); setDraft(value.draft); setLastSaved(JSON.stringify(value.draft)); setError(null); setSaveError(null);
    }).catch(err => { if (live) setError(err instanceof Error ? err.message : "Could not read setup progress."); });
    return () => { live = false; };
  }, [loadTick]);

  // One save at a time. New edits made during a save remain local and queue the next revision.
  useEffect(() => {
    if (!state || !draft || state.status !== "pending" || saving || working || saveError || JSON.stringify(draft) === lastSaved) return;
    const snapshot = draft;
    const timer = setTimeout(() => {
      setSaving(true);
      onboarding.save(state.version, snapshot).then(value => {
        setLastSaved(JSON.stringify(snapshot));
        setState(value);
      }).catch(err => setSaveError(err instanceof ApiError && err.status === 409 ? "Setup changed in another window. Reload saved progress to continue." : err instanceof Error ? err.message : "Could not save progress. Your edits remain here."))
        .finally(() => setSaving(false));
    }, 500);
    return () => clearTimeout(timer);
  }, [state, draft, saving, working, saveError, lastSaved]);

  const enginesChanged = useCallback((items: Engine[]) => {
    setEngines(items);
    setDraft(previous => {
      if (!previous || previous.provider) return previous;
      const provider = firstReadyEngine(items);
      return provider ? { ...previous, provider } : previous;
    });
  }, []);

  useEffect(() => {
    let live = true;
    api.getEngines().then(items => { if (live) enginesChanged(items); }).catch(() => {});
    return () => { live = false; };
  }, [enginesChanged]);

  const change = (values: Partial<OnboardingDraft>) => { setDraft(previous => previous && ({ ...previous, ...values })); setSaveError(null); setError(null); };
  const engine = engines.find(item => item.id === draft?.provider);
  const dirty = draft !== null && JSON.stringify(draft) !== lastSaved;

  async function finish(skip = false) {
    if (!state || !draft) return;
    setWorking(true); setError(null);
    try {
      let version = state.version;
      if (dirty) {
        const saved = await onboarding.save(version, draft);
        setLastSaved(JSON.stringify(draft)); setState(saved); version = saved.version;
      }
      const result = skip ? await onboarding.skip(version) : await onboarding.complete(version, draft);
      setState(result); router.push(skip ? "/chat/" : onboardingChatHref(result));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not finish setup. Your saved changes are kept."); }
    finally { setWorking(false); }
  }

  async function restart() {
    if (!state) return;
    setWorking(true); setError(null);
    try {
      const next = await onboarding.restart(state.version);
      setState(next); setDraft(next.draft); setLastSaved(JSON.stringify(next.draft));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not reopen setup."); }
    finally { setWorking(false); }
  }

  return <main className="mx-auto min-h-dvh max-w-2xl space-y-6 px-5 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><Link href="/chat/" className="text-sm underline">Open Duet</Link><ThemeToggle /></header>
    {error && <p role="alert" className="rounded-md border border-danger p-3 text-sm">{error}</p>}
    {!state || !draft ? <div className="space-y-3"><p role="status">{error ? "Setup progress is unavailable." : "Loading setup…"}</p>{error && <><button className={BUTTON} onClick={() => setLoadTick(value => value + 1)}>Try again</button><Link className="ml-3 text-sm underline" href="/settings/">Settings</Link></>}</div> : state.status !== "pending" ? <section className="space-y-4 rounded-xl border border-line p-5">
      <h1 className="text-2xl font-semibold">{state.status === "skipped" ? "Set up when you are ready" : "Your setup is saved"}</h1>
      <p className="text-sm text-muted">You can revisit the guide. Existing agents, conversations and permissions stay as you left them.</p>
      <button className={BUTTON} disabled={working} onClick={() => void restart()}>Continue setup</button><Link href="/chat/" className="ml-3 text-sm underline">Go to chat</Link>
    </section> : <>
      <ol className="flex flex-wrap gap-3 text-xs" aria-label="Setup progress">{STEPS.map((label, index) => <li key={label} aria-current={index === draft.step ? "step" : undefined} className={index === draft.step ? "font-semibold" : "text-muted"}>{index + 1}. {label}</li>)}</ol>
      <section className="space-y-5 rounded-xl border border-line p-5" aria-label="First-run setup">
        {draft.step === 0 && <>
          <h1 className="text-2xl font-semibold">Welcome to Open Duet</h1>
          <p>Connect an AI, give your first agent a purpose, and try a request.</p>
          <p className="text-sm text-muted">{state.execution_host === "desktop" ? "Agents and their workspaces run on this computer." : "Agents and their workspaces run on the server hosting this app. Your browser does not grant access to this device's files."}</p>
          <p className="text-sm text-muted">Your app account and your AI subscription are separate. Connect an AI you already use, or configure an API endpoint. Provider costs and limits still apply.</p>
          <p className="text-sm text-muted">The interface is currently available in English. You can change its appearance above.</p>
          {state.existing_agents && <p className="text-sm">You already have agents. Choose whether to keep using them in the agent step.</p>}
        </>}
        {draft.step === 1 && <>
          <h1 className="text-xl font-semibold">Connect an AI</h1>
          <p className="text-sm text-muted">Sign in with an existing subscription or add an API key. An engine must be ready before you continue.</p>
          {engines.length > 0 && <EngineModelFields engines={engines} provider={draft.provider} model={draft.model} disabled={working} onChange={(provider, model) => change({ provider, model, make_lead: false })} />}
          <EngineSettings onEnginesChanged={enginesChanged} />
        </>}
        {draft.step === 2 && <>
          <h1 className="text-xl font-semibold">Give your agent a purpose</h1>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.create_agent} disabled={working} onChange={event => change({ create_agent: event.target.checked, make_lead: false })} />Create a starter agent</label>
          {draft.create_agent ? <>
            <div className="flex flex-wrap gap-2">{STARTER_ROLES.map(role => <button key={role.name} className={BUTTON} disabled={working} onClick={() => change({ name: role.name, purpose: role.purpose, first_request: role.first_request })}>{role.name}</button>)}</div>
            <label className="block text-sm">Agent name<input className={FIELD} maxLength={80} value={draft.name} disabled={working} onChange={event => change({ name: event.target.value })} /></label>
            <label className="block text-sm">What should it help with?<textarea className={FIELD} rows={4} maxLength={4000} value={draft.purpose} disabled={working} onChange={event => change({ purpose: event.target.value })} /></label>
            <label className="block text-sm">First request<textarea className={FIELD} rows={3} maxLength={4000} value={draft.first_request} disabled={working} onChange={event => change({ first_request: event.target.value })} /><span className="mt-1 block text-xs text-muted">This opens as a draft in chat. You review it and press Send.</span></label>
            {engine?.capabilities.mcp && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.make_lead} disabled={working} onChange={event => change({ make_lead: event.target.checked })} />Make this agent the team lead so it can help create specialists and delegate work.</label>}
            <p className="text-xs text-muted">Starts with Ask-first approvals. Choosing a role does not connect email, calendar or computer access.</p>
          </> : <p className="text-sm text-muted">Continue with your existing agents or start a plain conversation. You can create an agent from Agents later.</p>}
        </>}
        {draft.step === 3 && <>
          <h1 className="text-xl font-semibold">Ready for your first conversation</h1>
          <p className="text-sm">{engine?.label ?? draft.provider} · {draft.model || "Default model"}</p>
          <p className="text-sm">{draft.create_agent ? `${draft.name.trim()} will help with: ${draft.purpose.trim()}` : "Continue with your existing agents or a plain chat."}</p>
          <p className="text-sm text-muted">{state.execution_host === "desktop" ? "New agents use this app's workspace on your computer." : "New agents use the configured server workspace."} Agent approval mode starts at Ask first.</p>
          <DesktopPermissions />
          <details className="text-sm"><summary className="cursor-pointer">Optional apps and computer access</summary><div className="mt-3 space-y-2 text-muted"><p>Connect apps in Settings when you need them. Choose a computer in Agents when a task requires browser or desktop control.</p><p>On a supported Mac, native computer access asks for system permissions. Denying those permissions does not prevent chat. Never grant screen access just to finish this guide.</p><Link className="underline" href="/settings/">Open Settings</Link></div></details>
          <p className="text-sm text-muted">If the first reply fails, keep the agent and retry or choose another engine. Saving setup does not mean a reply has succeeded.</p>
        </>}
      </section>
      <div className="space-y-2">
        <p role="status" className="text-xs text-muted">{saving ? "Saving progress…" : saveError ? "Progress could not be saved." : dirty ? "Changes waiting to save…" : "Progress saved. You can return later."}</p>
        {saveError && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{saveError}</p><button className={BUTTON} disabled={saving || working} onClick={() => setSaveError(null)}>Try saving again</button><button className={`${BUTTON} ml-2`} disabled={saving || working} onClick={() => setLoadTick(value => value + 1)}>Reload saved progress</button></div>}
        <div className="flex flex-wrap gap-2">
          {draft.step > 0 && <button className={BUTTON} disabled={saving || working} onClick={() => change({ step: draft.step - 1 })}>Back</button>}
          {draft.step < 3 ? <button className={BUTTON} disabled={saving || working || !!saveError || (draft.step === 1 && !engine?.available) || (draft.step === 2 && draft.create_agent && (!draft.name.trim() || !draft.purpose.trim()))} onClick={() => change({ step: draft.step + 1 })}>Continue</button> : <button className={BUTTON} disabled={saving || working || !!saveError} onClick={() => void finish()}>{working ? "Saving…" : "Open chat"}</button>}
          <button className={`${BUTTON} ml-auto`} disabled={saving || working} onClick={() => void finish(true)}>Set up later</button>
        </div>
      </div>
    </>}
  </main>;
}
