"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ApplicationSetting, type ApprovalMode, type DesktopSettings, type Engine } from "@/lib/api";
import { APPROVAL_MODES, modelLabel } from "@/lib/agents";
import { EngineSettings } from "./EngineSettings";
import { EngineModelFields } from "./chat/EngineModelFields";
import { firstReadyEngine } from "@/lib/engines";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Field, Input, Select } from "./ui/Input";
import { Stepper } from "./ui/Stepper";

const STEPS = ["Engine", "Workspace", "Approvals", "Ready"];

export function DesktopSetup({ settings, onSaved, onFinished }: {
  settings: DesktopSettings;
  onSaved: (setting: ApplicationSetting) => void;
  onFinished: (agentId?: number, selection?: { provider: string; model: string | null }) => void;
}) {
  const row = (key: string) => settings.settings.find((item) => item.key === key);
  const [step, setStep] = useState(0);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState(String(row("LOCAL_WORKSPACE_ROOT")?.value ?? ""));
  const [tools, setTools] = useState(row("LOCAL_TOOLS_ENABLED")?.value === true);
  const [mode, setMode] = useState<ApprovalMode>("ask");
  const [createAgent, setCreateAgent] = useState<boolean | null>(null);
  const [agentName, setAgentName] = useState("Assistant");
  const [leadsTeam, setLeadsTeam] = useState(true);
  const [existing, setExisting] = useState<{ id: number; name: string; provider: string }[]>([]);
  const [leadPick, setLeadPick] = useState("");
  const [createdAgentId, setCreatedAgentId] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = engines.find((item) => item.id === provider);
  const enginesChanged = useCallback((items: Engine[]) => {
    setEngines(items);
    setProvider((current) => firstReadyEngine(items, current) ?? current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listAgents().then((agents) => {
      if (cancelled) return;
      setExisting(agents.filter((agent) => agent.provider === "claude").map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider })));
      setCreateAgent((previous) => previous ?? agents.length === 0);
    }).catch(() => { if (!cancelled) setError("Could not load agents. Reload Settings to try again, or set up later."); });
    return () => { cancelled = true; };
  }, []);

  const browse = async () => {
    setError(null); setBusy(true);
    try {
      if (!window.openDots) throw new Error("Folder selection is available in the desktop app.");
      const selected = await window.openDots.choosePath("folder");
      if (selected !== null) setWorkspace(selected);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not choose a folder."); }
    finally { setBusy(false); }
  };

  const complete = async (skip = false) => {
    setBusy(true); setError(null);
    let agentId = createdAgentId;
    try {
      if (!skip) {
        if (!engine?.available) throw new Error("Choose an available engine, or set up later.");
        for (const [key, value] of [["LOCAL_WORKSPACE_ROOT", workspace.trim()], ["LOCAL_TOOLS_ENABLED", tools]] as const) {
          const current = row(key);
          if (!current) throw new Error("This backend does not support setup. Update it and try again.");
          if (value !== current.value) onSaved(await api.saveDesktopSetting(key, value, current.version));
        }
        if (createAgent) {
          const input = { name: agentName.trim(), instructions: "", provider, model: model?.trim() || null, approval_mode: mode };
          const saved = agentId === undefined ? await api.createAgent(input) : await api.updateAgent(agentId, input);
          agentId = saved.id;
          setCreatedAgentId(saved.id);
          if (leadsTeam && provider === "claude") await api.requestTeamLead(saved.id);
        } else if (leadPick) {
          await api.requestTeamLead(Number(leadPick));
        }
      }
      const completed = row("DESKTOP_ONBOARDING_COMPLETED");
      if (!completed) throw new Error("This backend does not support setup. Update it and try again.");
      if (completed.value !== true) onSaved(await api.saveDesktopSetting(completed.key, true, completed.version));
      onFinished(skip ? undefined : agentId, skip ? undefined : { provider, model: model?.trim() || null });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not finish setup. Your saved changes are kept; retry to continue.");
    } finally { setBusy(false); }
  };

  const last = STEPS.length - 1;
  const canContinue = !busy && createAgent !== null
    && !(step === 0 && !engine?.available)
    && !(step === 2 && createAgent === true && !agentName.trim());
  const go = (delta: number) => { setError(null); setStep((value) => value + delta); };

  return (
    <section aria-label="First-run setup" className="space-y-5 rounded-card border border-line bg-raised p-5">
      <div>
        <h2 className="text-heading font-semibold">Welcome to Open Duet</h2>
        <p className="mt-2 text-sm text-muted">Choose how your agents work on this computer. You can change these choices in Settings and Agents.</p>
      </div>
      <Stepper steps={STEPS} current={step} />
      {error && <Banner tone="danger">{error}</Banner>}

      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{engine?.available ? `${engine.label} is ready. Continue to choose a workspace.` : "Connect an AI"}</p>
          {engine?.available && (
            <details>
              <summary className="cursor-pointer text-sm underline">Advanced: engine and model</summary>
              <div className="mt-3">
                <EngineModelFields engines={engines} provider={provider} model={model} disabled={busy} onChange={(nextProvider, nextModel) => { setProvider(nextProvider); setModel(nextModel); }} />
              </div>
            </details>
          )}
          <EngineSettings onEnginesChanged={enginesChanged} />
          {!engines.length && <p role="status" className="text-sm text-muted">Checking installed engines…</p>}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <Field label="Default workspace root">
            {(p) => <Input {...p} aria-label="Setup workspace root" value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={busy} placeholder="Use the app's own workspace" autoComplete="off" spellCheck={false} />}
          </Field>
          <Button disabled={busy} onClick={() => void browse()}>Choose folder</Button>
          <p className="break-all text-xs text-muted">App default: {String(row("LOCAL_WORKSPACE_ROOT")?.default ?? "")}</p>
          <p className="text-sm text-muted">New agents get their own subfolders here. To work directly in an existing project, set that agent&apos;s workspace in Agents.</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Checkbox label="Allow tools on this computer" description="When off, local CLIs stay read only. API endpoints are chat only. Tool-capable engines use their own permissions and the app's approval cards." checked={tools} disabled={busy} onChange={(event) => setTools(event.target.checked)} />
          <Checkbox label="Create a starter agent with the selected engine" checked={createAgent === true} disabled={busy || createAgent === null} onChange={(event) => setCreateAgent(event.target.checked)} />
          {createAgent && provider === "claude" && (
            <Checkbox label="Leads a team: can create specialists and delegate with the team approval settings" checked={leadsTeam} disabled={busy} onChange={(event) => setLeadsTeam(event.target.checked)} />
          )}
          {createAgent === false && existing.length > 0 && (
            <Field label="Team lead (optional)" hint="The lead can add specialists and hand work to them. You can change this later in Team.">
              {(p) => (
                <Select {...p} aria-label="Team lead" value={leadPick} disabled={busy} onChange={(event) => setLeadPick(event.target.value)}>
                  <option value="">No lead yet</option>
                  {existing.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </Select>
              )}
            </Field>
          )}
          {createAgent && (
            <Field label="Agent name">
              {(p) => <Input {...p} aria-label="Starter agent name" maxLength={80} value={agentName} disabled={busy} onChange={(event) => setAgentName(event.target.value)} />}
            </Field>
          )}
          <fieldset className="space-y-2" disabled={busy || !createAgent}>
            <legend className="mb-2 text-sm font-medium">Starter agent approval mode</legend>
            {APPROVAL_MODES.map((option) => (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input type="radio" name="setup-approval" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-0.5 accent-(--accent)" />
                <span>{option.label}<span className="mt-1 block text-xs text-muted">{option.description}</span></span>
              </label>
            ))}
          </fieldset>
          {!createAgent && <p className="text-xs text-muted">Your existing agents keep their approval modes. Change them in Agents.</p>}
        </div>
      )}

      {step === last && (
        <div className="space-y-3 text-sm">
          <h3 className="text-title font-semibold">Ready to start</h3>
          <dl className="divide-y divide-line rounded-field border border-line bg-inset">
            <SummaryRow label="Engine" value={`${engine?.label ?? provider} · ${modelLabel(model)}`} />
            <SummaryRow label="Workspace root" value={workspace.trim() || "App default"} />
            <SummaryRow label="Local tools" value={tools ? "on" : "off"} />
            <SummaryRow label="Agent" value={createAgent ? `Create ${agentName.trim()} with ${APPROVAL_MODES.find((item) => item.value === mode)?.label}.` : "Use your existing agents, or start a plain chat."} />
          </dl>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {step > 0 && <Button disabled={busy} onClick={() => go(-1)}>Back</Button>}
        {step < last
          ? <Button variant="primary" disabled={!canContinue} onClick={() => go(1)}>Continue</Button>
          : <Button variant="primary" disabled={busy} loading={busy} onClick={() => void complete()}>{busy ? "Saving…" : "Start chatting"}</Button>}
        <Button className="ml-auto" variant="ghost" disabled={busy} onClick={() => void complete(true)}>Set up later</Button>
      </div>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 px-3 py-2">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-all">{value}</dd>
    </div>
  );
}
