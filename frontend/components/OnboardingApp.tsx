"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Engine } from "@/lib/api";
import { firstReadyEngine } from "@/lib/engines";
import { useT } from "@/lib/use-i18n";
import { onboarding, onboardingChatHref, STARTER_ROLES, type OnboardingDraft, type OnboardingState } from "@/lib/onboarding";
import { EngineSettings } from "./EngineSettings";
import { EngineModelFields } from "./chat/EngineModelFields";
import { DesktopPermissions } from "./DesktopPermissions";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Field, Input, Textarea } from "./ui/Input";
import { SkeletonList } from "./ui/Skeleton";
import { Stepper } from "./ui/Stepper";
import { ThemeToggle } from "./ui/ThemeToggle";
import { LanguageSelect } from "./settings/LanguageSelect";

export function OnboardingApp() {
  const t = useT();
  const router = useRouter();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const steps = [t("onboarding.step.welcome"), t("onboarding.step.engine"), t("onboarding.step.agent"), t("onboarding.step.ready")];
  const starterRoles = [
    { name: t("onboarding.role.writing.name"), purpose: t("onboarding.role.writing.purpose"), first_request: t("onboarding.role.writing.firstRequest") },
    { name: t("onboarding.role.research.name"), purpose: t("onboarding.role.research.purpose"), first_request: t("onboarding.role.research.firstRequest") },
    { name: t("onboarding.role.planning.name"), purpose: t("onboarding.role.planning.purpose"), first_request: t("onboarding.role.planning.firstRequest") },
  ];
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
    }).catch(err => { if (live) setError(err instanceof Error ? err.message : tRef.current("onboarding.error.readUnavailable")); });
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
      }).catch(err => setSaveError(err instanceof ApiError && err.status === 409 ? tRef.current("onboarding.error.saveConflict") : err instanceof Error ? err.message : tRef.current("onboarding.error.saveFailed")))
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
    } catch (err) { setError(err instanceof Error ? err.message : t("onboarding.error.finishFailed")); }
    finally { setWorking(false); }
  }

  async function restart() {
    if (!state) return;
    setWorking(true); setError(null);
    try {
      const next = await onboarding.restart(state.version);
      setState(next); setDraft(next.draft); setLastSaved(JSON.stringify(next.draft));
    } catch (err) { setError(err instanceof Error ? err.message : t("onboarding.error.reopenFailed")); }
    finally { setWorking(false); }
  }

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <Link href="/chat/" className="text-sm underline">Open Duet</Link>
      <div className="flex items-center gap-2"><LanguageSelect compact /><ThemeToggle /></div>
    </header>
  );

  if (!state || !draft) {
    return (
      <main className="mx-auto min-h-dvh max-w-2xl space-y-6 px-5 py-8">
        {header}
        {error && <Banner tone="danger">{error}</Banner>}
        {error ? (
          <div className="space-y-3">
            <p role="status">{t("onboarding.statusUnavailable")}</p>
            <div className="flex items-center gap-3">
              <Button onClick={() => setLoadTick((value) => value + 1)}>{t("onboarding.retry")}</Button>
              <Link className="text-sm underline" href="/settings/">{t("sidebar.settings")}</Link>
            </div>
          </div>
        ) : (
          <div className="space-y-3"><p role="status" className="text-sm text-muted">{t("onboarding.loading")}</p><SkeletonList rows={3} /></div>
        )}
      </main>
    );
  }

  if (state.status !== "pending") {
    return (
      <main className="mx-auto min-h-dvh max-w-2xl space-y-6 px-5 py-8">
        {header}
        {error && <Banner tone="danger">{error}</Banner>}
        <section className="space-y-4 rounded-card border border-line bg-raised p-5">
          <h1 className="text-heading font-semibold">{state.status === "skipped" ? t("onboarding.status.skipped") : t("onboarding.status.saved")}</h1>
          <p className="text-sm text-muted">{t("onboarding.revisit")}</p>
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={working} onClick={() => void restart()}>{t("onboarding.continueSetup")}</Button>
            <Link href="/chat/" className="text-sm underline">{t("onboarding.goToChat")}</Link>
          </div>
        </section>
      </main>
    );
  }

  const locked = saving || working;
  const canContinue = !locked && !saveError
    && !(draft.step === 1 && !engine?.available)
    && !(draft.step === 2 && draft.create_agent && (!draft.name.trim() || !draft.purpose.trim()));
  const hostNote = state.execution_host === "desktop"
    ? t("onboarding.host.desktop")
    : t("onboarding.host.server");
  const saveStatus = saving ? t("onboarding.saveStatus.saving") : saveError ? t("onboarding.saveStatus.failed") : dirty ? t("onboarding.saveStatus.pending") : t("onboarding.saveStatus.saved");

  return (
    <main className="mx-auto min-h-dvh max-w-2xl space-y-6 px-5 py-8">
      {header}
      {error && <Banner tone="danger">{error}</Banner>}
      <Stepper steps={steps} current={draft.step} />
      <section className="space-y-5 rounded-card border border-line bg-raised p-5" aria-label={t("onboarding.ariaLabel")}>
        {draft.step === 0 && (
          <>
            <h1 className="text-heading font-semibold">{t("onboarding.welcome.title")}</h1>
            <p>{t("onboarding.welcome.description")}</p>
            <p className="text-sm text-muted">{hostNote}</p>
            <p className="text-sm text-muted">{t("onboarding.welcome.accountNote")}</p>
            {state.existing_agents && <p className="text-sm">{t("onboarding.welcome.existingAgents")}</p>}
          </>
        )}
        {draft.step === 1 && (
          <>
            <h1 className="text-title font-semibold">{t("onboarding.engine.title")}</h1>
            <p className="text-sm text-muted">{t("onboarding.engine.description")}</p>
            {engines.length > 0 && (
              <EngineModelFields engines={engines} provider={draft.provider} model={draft.model} disabled={working} onChange={(provider, model) => change({ provider, model, make_lead: false })} />
            )}
            <EngineSettings onEnginesChanged={enginesChanged} />
          </>
        )}
        {draft.step === 2 && (
          <>
            <h1 className="text-title font-semibold">{t("onboarding.agent.title")}</h1>
            <Checkbox label={t("onboarding.agent.createStarter")} checked={draft.create_agent} disabled={working} onChange={(event) => change({ create_agent: event.target.checked, make_lead: false })} />
            {draft.create_agent ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {STARTER_ROLES.map((role, index) => {
                    const translatedRole = starterRoles[index] ?? role;
                    return <Button key={role.name} size="sm" disabled={working} onClick={() => change({ name: translatedRole.name, purpose: translatedRole.purpose, first_request: translatedRole.first_request })}>{translatedRole.name}</Button>;
                  })}
                </div>
                <Field label={t("onboarding.agent.name")}>{(p) => <Input {...p} maxLength={80} value={draft.name} disabled={working} onChange={(event) => change({ name: event.target.value })} />}</Field>
                <Field label={t("onboarding.agent.purpose")}>{(p) => <Textarea {...p} rows={4} maxLength={4000} value={draft.purpose} disabled={working} onChange={(event) => change({ purpose: event.target.value })} />}</Field>
                <Field label={t("onboarding.agent.firstRequest")} hint={t("onboarding.agent.firstRequestHint")}>
                  {(p) => <Textarea {...p} rows={3} maxLength={4000} value={draft.first_request} disabled={working} onChange={(event) => change({ first_request: event.target.value })} />}
                </Field>
                {engine?.capabilities.mcp && (
                  <Checkbox label={t("onboarding.agent.makeLead")} checked={draft.make_lead} disabled={working} onChange={(event) => change({ make_lead: event.target.checked })} />
                )}
                <p className="text-xs text-muted">{t("onboarding.agent.askFirstNote")}</p>
              </>
            ) : (
              <p className="text-sm text-muted">{t("onboarding.agent.existing")}</p>
            )}
          </>
        )}
        {draft.step === 3 && (
          <>
            <h1 className="text-title font-semibold">{t("onboarding.ready.title")}</h1>
            <p className="text-sm">{engine?.label ?? draft.provider} · {draft.model || t("onboarding.model.default")}</p>
            <p className="text-sm">{draft.create_agent ? t("onboarding.summary.createdAgent", { name: draft.name.trim(), purpose: draft.purpose.trim() }) : t("onboarding.summary.continueExisting")}</p>
            <p className="text-sm text-muted">{state.execution_host === "desktop" ? t("onboarding.workspace.desktop") : t("onboarding.workspace.server")} {t("onboarding.approvalMode")}</p>
            <DesktopPermissions />
            <details className="text-sm">
              <summary className="cursor-pointer">{t("onboarding.access.summary")}</summary>
              <div className="mt-3 space-y-2 text-muted">
                <p>{t("onboarding.access.description")}</p>
                <p>{t("onboarding.access.native")}</p>
                <Link className="underline" href="/apps/">{t("onboarding.openApps")}</Link>
              </div>
            </details>
            <p className="text-sm text-muted">{t("onboarding.firstReplyFailed")}</p>
          </>
        )}
      </section>
      <div className="space-y-3">
        <p role="status" className="text-xs text-muted">{saveStatus}</p>
        {saveError && (
          <Banner tone="danger" action={
            <>
              <Button size="sm" disabled={locked} onClick={() => setSaveError(null)}>{t("onboarding.saveAgain")}</Button>
              <Button size="sm" disabled={locked} onClick={() => setLoadTick((value) => value + 1)}>{t("onboarding.reloadProgress")}</Button>
            </>
          }>{saveError}</Banner>
        )}
        <div className="flex flex-wrap gap-2">
          {draft.step > 0 && <Button disabled={locked} onClick={() => change({ step: draft.step - 1 })}>{t("onboarding.back")}</Button>}
          {draft.step < 3
            ? <Button variant="primary" disabled={!canContinue} onClick={() => change({ step: draft.step + 1 })}>{t("onboarding.continue")}</Button>
            : <Button variant="primary" disabled={locked || !!saveError} loading={working} onClick={() => void finish()}>{working ? t("onboarding.saving") : t("onboarding.openChat")}</Button>}
          <Button className="ml-auto" variant="ghost" disabled={locked} onClick={() => void finish(true)}>{t("onboarding.setUpLater")}</Button>
        </div>
      </div>
    </main>
  );
}
