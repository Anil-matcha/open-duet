"use client";

import { Dialog } from "@/components/ui/Dialog";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type Agent,
  type ApprovalMode,
  type ConnectedAppGrant,
  type Routine,
  type RoutineInput,
  type RoutineAppAction,
  type RoutineRun,
  type SchedulePreview,
} from "@/lib/api";
import type { ComposioAccount } from "@/lib/connected-apps";
import { activeAgents, APPROVAL_MODES } from "@/lib/agents";
import {
  curlExample,
  DAY_LABELS,
  emptySchedule,
  formatSchedulePreviewWhen,
  formatWhen,
  isActiveRun,
  nextRunText,
  runStateLabel,
  runStateTone,
  SCHEDULE_KINDS,
  scheduleDraftOf,
  schedulePreviewKey,
  scheduleSpec,
  canSaveSchedulePreview,
  triggerLabel,
  webhookUrl,
  type ScheduleDraft,
} from "@/lib/routines";

const REFRESH_MS = 5_000;
const input = "w-full rounded-md border border-line bg-transparent px-2 py-1.5 text-sm";
const button = "cursor-pointer rounded-md border border-line px-2 py-1 text-xs hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

const TONE: Record<ReturnType<typeof runStateTone>, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  busy: "text-accent",
  muted: "text-muted",
};

type Draft = {
  id: number | null;
  name: string;
  agentId: number | null;
  prompt: string;
  schedule: ScheduleDraft;
  runLimit: string;
  approvalMode: ApprovalMode;
  approvalWait: string;
  catchUp: string;
  retryLimit: string;
  retryDelay: string;
  connectedAppGrants: ConnectedAppGrant[];
};

// These exact tool identifiers mirror the routine-safe read inventory and the
// three separately authorized writes supported by the backend.
const ROUTINE_READ_TOOLS = [
  { app: "github", label: "GitHub", tools: [
    ["github_get_authenticated_user", "View account profile"], ["github_list_my_repositories", "List repositories"],
    ["github_list_issues", "List repository issues"], ["github_get_issue", "Read an issue"],
    ["github_list_issue_comments", "Read issue comments"], ["github_list_pull_requests", "List pull requests"],
    ["github_get_pull_request", "Read a pull request"], ["github_list_pull_request_files", "List pull request files"],
    ["github_list_commits", "List commits"], ["github_list_branches", "List branches"],
    ["github_get_file", "Read repository files"], ["github_search_issues", "Search issues and pull requests"],
    ["github_list_workflow_runs", "List workflow runs"],
  ], writes: [
    ["github_create_branch", "Create a campaign/ branch"], ["github_commit_file", "Commit one file to a campaign/ branch"],
  ] },
  { app: "gmail", label: "Gmail", tools: [
    ["gmail_fetch_emails", "Search messages"], ["gmail_fetch_message", "Read a message"],
    ["gmail_fetch_thread", "Read a thread"], ["gmail_get_profile", "View account profile"],
  ], writes: [["gmail_send_email", "Send one plain-text email to one recipient"]] },
  { app: "googlecalendar", label: "Google Calendar", tools: [
    ["googlecalendar_list_calendars", "List calendars"], ["googlecalendar_list_events", "List events"],
  ], writes: [] },
] as const;

function newDraft(agents: Agent[]): Draft {
  return {
    id: null, name: "", agentId: agents[0]?.id ?? null, prompt: "", schedule: emptySchedule(),
    runLimit: "30", approvalMode: "ask", approvalWait: "30", catchUp: "60",
    retryLimit: "0", retryDelay: "5", connectedAppGrants: [],
  };
}

function draftOf(routine: Routine): Draft {
  return {
    id: routine.id, name: routine.name, agentId: routine.agent_id, prompt: routine.prompt,
    schedule: scheduleDraftOf(routine), runLimit: String(routine.run_limit_minutes),
    approvalMode: routine.approval_mode, approvalWait: String(routine.approval_timeout_minutes),
    catchUp: String(routine.catch_up_minutes), retryLimit: String(routine.retry_limit),
    retryDelay: String(routine.retry_delay_minutes),
    connectedAppGrants: routine.connected_app_grants ?? [],
  };
}

function inputOf(draft: Draft): RoutineInput {
  return {
    agent_id: draft.agentId ?? 0,
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    schedule_kind: draft.schedule.kind,
    schedule_spec: scheduleSpec(draft.schedule),
    timezone: draft.schedule.timezone.trim() || "UTC",
    run_limit_minutes: Number(draft.runLimit),
    approval_mode: draft.approvalMode,
    approval_timeout_minutes: Number(draft.approvalWait),
    catch_up_minutes: Number(draft.catchUp),
    retry_limit: Number(draft.retryLimit),
    retry_delay_minutes: Number(draft.retryDelay),
    connected_app_grants: draft.connectedAppGrants,
  };
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return "Could not reach the backend.";
}

function State({ state }: { state: string }) {
  return <span className={`text-xs font-medium ${TONE[runStateTone(state)]}`}>{runStateLabel(state)}</span>;
}

// The schedule part of the editor, with the server's own summary and next three dates.
function ScheduleFields({ value, onChange, onPreviewResult }: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  onPreviewResult: (key: string, valid: boolean) => void;
}) {
  const [previewResult, setPreviewResult] = useState<{
    key: string;
    preview: SchedulePreview | null;
    problem: string | null;
  } | null>(null);
  const previewKey = schedulePreviewKey(value);
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.previewSchedule(value.kind, scheduleSpec(value), value.timezone.trim() || "UTC")
        .then((preview) => {
          if (live) {
            setPreviewResult({ key: previewKey, preview, problem: null });
            onPreviewResult(previewKey, true);
          }
        })
        .catch((err) => {
          if (live) {
            setPreviewResult({ key: previewKey, preview: null, problem: errorText(err, "This schedule is not valid.") });
            onPreviewResult(previewKey, false);
          }
        });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [value, previewKey, onPreviewResult]);

  const currentPreview = previewResult?.key === previewKey ? previewResult : null;

  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-muted">Schedule</legend>
      <select aria-label="Schedule kind" value={value.kind} onChange={(e) => set({ kind: e.target.value as ScheduleDraft["kind"] })} className={input}>
        {SCHEDULE_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
      </select>
      {value.kind === "weekdays" && (
        <div className="flex flex-wrap items-center gap-1">
          {DAY_LABELS.map((label, day) => {
            const on = value.days.includes(day);
            return (
              <button key={label} type="button" aria-pressed={on} onClick={() => set({ days: on ? value.days.filter((d) => d !== day) : [...value.days, day] })}
                className={`cursor-pointer rounded px-2 py-1 text-xs ${on ? "bg-accent text-accent-fg hover:opacity-90" : "border border-line"}`}>
                {label}
              </button>
            );
          })}
          <input aria-label="Time" type="time" value={value.time} onChange={(e) => set({ time: e.target.value })} className="ml-2 rounded-md border border-line bg-transparent px-2 py-1 text-sm" />
        </div>
      )}
      {value.kind === "interval" && (
        <label className="flex items-center gap-2 text-sm">Every
          <input aria-label="Minutes between runs" type="number" min={5} max={10080} value={value.everyMinutes} onChange={(e) => set({ everyMinutes: e.target.value })} className="w-24 rounded-md border border-line bg-transparent px-2 py-1" />
          minutes
        </label>
      )}
      {value.kind === "cron" && (
        <input aria-label="Cron expression" value={value.expression} onChange={(e) => set({ expression: e.target.value })} placeholder="minute hour day month weekday, e.g. 0 9 * * 1-5" spellCheck={false} className={`${input} font-mono`} />
      )}
      {value.kind === "once" && (
        <input aria-label="Date and time" type="datetime-local" value={value.at} onChange={(e) => set({ at: e.target.value })} className={input} />
      )}
      {value.kind !== "manual" && value.kind !== "interval" && (
        <label className="block text-xs text-muted">Time zone
          <input aria-label="Time zone" value={value.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Berlin" spellCheck={false} className={input} />
        </label>
      )}
      {currentPreview?.problem ? (
        <p role="alert" className="text-xs text-danger">{currentPreview.problem}</p>
      ) : currentPreview?.preview ? (
        <div className="text-xs text-muted" aria-label="Schedule preview">
          <p className="font-medium">{currentPreview.preview.summary}</p>
          {currentPreview.preview.next_dates.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
              {currentPreview.preview.next_dates.map((date) => <li key={date}>{formatSchedulePreviewWhen(date, value.timezone.trim() || "UTC")}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <p role="status" className="text-xs text-muted">Checking schedule…</p>
      )}
    </fieldset>
  );
}

function RunHistory({ routine, onClose, onOpen }: { routine: Routine; onClose: () => void; onOpen: () => void }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.listRoutineRuns(routine.id).then((r) => live && setRuns(r)).catch((err) => live && setError(errorText(err, "Could not load runs.")));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [routine.id]);
  return (
    <div className="space-y-3">
      <button onClick={onClose} className={button}>← Back</button>
      <h3 className="text-sm font-semibold">Runs of {routine.name}</h3>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {runs === null ? <p className="text-sm text-muted">Loading…</p> : runs.length === 0 ? <p className="text-sm text-muted">No runs yet.</p> : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id} className="rounded-md border border-line p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <State state={run.state} />
                <span className="text-xs text-muted">{triggerLabel(run.trigger)}{run.attempt > 1 ? ` (attempt ${run.attempt})` : ""} · {formatWhen(run.scheduled_for ?? run.created_at, routine.timezone)}</span>
                {run.thread_id !== null && (
                  <Link href={`/chat?thread=${run.thread_id}`} onClick={onOpen} className="ml-auto text-xs underline">Open conversation</Link>
                )}
                <button type="button" className="ml-auto text-xs underline" aria-expanded={selectedRunId === run.id} onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}>
                  {selectedRunId === run.id ? "Hide app actions" : "App actions"}
                </button>
              </div>
              {(run.error || run.result) && (
                <p className={`mt-1 line-clamp-3 whitespace-pre-wrap text-xs ${run.error ? "text-danger" : "text-muted"}`}>{run.error || run.result}</p>
              )}
              {selectedRunId === run.id && <RunAppActions routineId={routine.id} runId={run.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunAppActions({ routineId, runId }: { routineId: number; runId: number }) {
  const [actions, setActions] = useState<RoutineAppAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.listRoutineRunAppActions(routineId, runId)
      .then((items) => { if (live) setActions(items); })
      .catch((err) => { if (live) setError(errorText(err, "Could not load app actions.")); });
    return () => { live = false; };
  }, [routineId, runId]);
  return <div className="mt-2 space-y-2 border-t border-line pt-2">
    <p className="text-xs text-muted">External app actions cannot be undone with file Undo. If an action outcome is uncertain, check the connected account before running it again.</p>
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : actions === null ? <p role="status" className="text-xs text-muted">Loading app actions…</p> : actions.length === 0 ? <p className="text-xs text-muted">No recorded app actions.</p> : (
      <ul className="space-y-1">{actions.map((action) => <li key={action.id} className="rounded border border-line p-2 text-xs">
        <p className="font-medium">{action.tool} · {action.status}</p>
        <p className="text-muted">Connected account: {action.account_id}{action.code ? ` · ${action.code}` : ""}</p>
        {action.result && <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(action.result, null, 2)}</pre>}
      </li>)}</ul>
    )}
  </div>;
}

export function RoutinesPanel({ agents, onClose, routineId = null }: { agents: Agent[]; onClose: () => void; routineId?: number | null }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [connectedAccounts, setConnectedAccounts] = useState<ComposioAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [validPreviewKey, setValidPreviewKey] = useState<string | null>(null);
  const [chosenHistory, chooseHistory] = useState<Routine | null>(null);
  const [requestedHistoryId, requestHistory] = useState(routineId);
  const history = chosenHistory ?? routines?.find(routine => routine.id === requestedHistoryId) ?? null;
  const setHistory = (next: Routine | null) => { requestHistory(null); chooseHistory(next); };
  const [secret, setSecret] = useState<{ routineId: number; secret: string; url: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const live = activeAgents(agents);

  const load = useCallback(() => {
    api.listRoutines().then(setRoutines).catch((err) => setError(errorText(err, "Could not load routines.")));
  }, []);

  const reportPreviewResult = useCallback((key: string, valid: boolean) => {
    setValidPreviewKey(valid ? key : null);
  }, []);

  useEffect(() => {
    load();
    api.listComposioAccounts().then(setConnectedAccounts).catch(() => setConnectedAccounts([]));
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggleRoutineGrant = (tool: string, accountId: string) => {
    if (!draft) return;
    const exists = draft.connectedAppGrants.some((grant) => grant.tool === tool);
    setDraft({ ...draft, connectedAppGrants: exists
      ? draft.connectedAppGrants.filter((grant) => grant.tool !== tool)
      : [...draft.connectedAppGrants, { tool, account_id: accountId }] });
  };

  const setRoutineGrantAccount = (app: string, accountId: string) => {
    if (!draft) return;
    const group = ROUTINE_READ_TOOLS.find((candidate) => candidate.app === app);
    const names = new Set<string>([...(group?.tools ?? []), ...(group?.writes ?? [])].map(([name]) => name));
    setDraft({ ...draft, connectedAppGrants: draft.connectedAppGrants.map((grant) =>
      names.has(grant.tool) ? { ...grant, account_id: accountId } : grant) });
  };

  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const body = inputOf(draft);
    const ok = await act(() => (draft.id === null ? api.createRoutine(body) : api.updateRoutine(draft.id, body)), "Could not save the routine.");
    if (ok) {
      setValidPreviewKey(null);
      setDraft(null);
    }
  };

  const agentName = (id: number) => agents.find((agent) => agent.id === id)?.name ?? `Agent ${id}`;
  const heading = draft ? (draft.id === null ? "New routine" : "Edit routine") : "Routines";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={heading} size="wide">
          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

          {history ? (
            <RunHistory routine={history} onClose={() => setHistory(null)} onOpen={onClose} />
          ) : draft ? (
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <label className="block text-xs text-muted">Name
                <input aria-label="Routine name" required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={input} />
              </label>
              <label className="block text-xs text-muted">Agent
                <select aria-label="Agent" value={draft.agentId ?? ""} onChange={(e) => setDraft({ ...draft, agentId: Number(e.target.value) })} className={input}>
                  {live.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted">What it should do
                <textarea aria-label="Prompt" required rows={4} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className={input} />
              </label>
              <ScheduleFields
                value={draft.schedule}
                onChange={(schedule) => {
                  setValidPreviewKey(null);
                  setDraft({ ...draft, schedule });
                }}
                onPreviewResult={reportPreviewResult}
              />
              <section className="space-y-3 rounded-md border border-line p-3" aria-labelledby="routine-app-access-title">
                <div>
                  <h3 id="routine-app-access-title" className="text-sm font-medium">Connected app access</h3>
                  <p className="mt-1 text-xs text-muted">Off by default. Choose exact read actions and the connected account each action uses. When routine app access is enabled on the server, these reads can run without an action-time approval. This does not expand the agent&apos;s own app access. Draft replies, other writes, webhooks, and routines with a computer are not available here.</p>
                </div>
                {connectedAccounts === null ? <p role="status" className="text-xs text-muted">Loading connected accounts…</p> : ROUTINE_READ_TOOLS.map((group) => {
                  const available = connectedAccounts.filter((account) => account.toolkit === group.app && account.status === "ACTIVE");
                  const allTools = [...group.tools, ...group.writes];
                  const current = draft.connectedAppGrants.find((grant) => allTools.some(([tool]) => tool === grant.tool));
                  const selectedAccount = (available.some((account) => account.id === current?.account_id)
                    ? current?.account_id : (available[0]?.id ?? current?.account_id)) ?? "";
                  return <fieldset key={group.app} className="space-y-2 border-t border-line pt-2">
                    <legend className="text-xs font-medium">{group.label}</legend>
                    <label className="block text-xs text-muted">Connected account
                      <select aria-label={`${group.label} connected account`} value={selectedAccount} disabled={available.length === 0 || !draft.connectedAppGrants.some((grant) => allTools.some(([tool]) => tool === grant.tool))} onChange={(event) => setRoutineGrantAccount(group.app, event.target.value)} className={input}>
                        {available.length === 0 ? <option value="">No connected account</option> : available.map((account) => <option key={account.id} value={account.id}>{account.alias ?? account.id}</option>)}
                        {current && !available.some((account) => account.id === current.account_id) && <option value={current.account_id}>Unavailable account ({current.account_id})</option>}
                      </select>
                    </label>
                    <div className="grid gap-1 sm:grid-cols-2">{group.tools.map(([tool, label]) => {
                      const grant = draft.connectedAppGrants.find((item) => item.tool === tool);
                      return <label key={tool} className="flex items-start gap-2 text-xs">
                        <input type="checkbox" checked={Boolean(grant)} disabled={!grant && !available.some((account) => account.id === selectedAccount)} onChange={() => toggleRoutineGrant(tool, grant?.account_id ?? selectedAccount)} />
                        <span>{label}{grant && grant.account_id !== selectedAccount ? <span className="text-warning"> · account unavailable</span> : null}</span>
                      </label>;
                    })}</div>
                    {group.writes.length > 0 && <div className="space-y-2 border-t border-line pt-2">
                      <div><p className="text-xs font-semibold">Write actions · explicitly authorize each one</p>
                        <p className="text-xs text-muted">Selecting an action is your one-time authorization for this exact action and account. Once authorized, it runs without an action-time approval. The agent must also have write access to this app. This is separate from the routine&apos;s approval mode and only takes effect when routine app access is enabled on the server.</p></div>
                      {group.writes.map(([tool, label]) => {
                        const grant = draft.connectedAppGrants.find((item) => item.tool === tool);
                        const agent = agents.find((item) => item.id === draft.agentId);
                        const hasWriteScope = agent?.connector_scopes?.[group.app] === "write";
                        return <label key={tool} className="flex items-start gap-2 text-xs">
                          <input type="checkbox" checked={Boolean(grant)} disabled={!grant && (!hasWriteScope || !available.some((account) => account.id === selectedAccount))} onChange={() => toggleRoutineGrant(tool, grant?.account_id ?? selectedAccount)} />
                          <span>{label}{grant && grant.account_id !== selectedAccount ? <span className="text-warning"> · account unavailable</span> : null}{!hasWriteScope && !grant ? <span className="text-muted"> · allow write access for this agent first</span> : null}</span>
                        </label>;
                      })}
                    </div>}
                  </fieldset>;
                })}
              </section>
              <details className="rounded-md border border-line p-3 text-xs">
                <summary className="cursor-pointer font-medium text-muted">Limits and approvals</summary>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label>Run limit (minutes)<input type="number" min={1} max={240} value={draft.runLimit} onChange={(e) => setDraft({ ...draft, runLimit: e.target.value })} className={input} /></label>
                  <label>Approval wait (minutes)<input type="number" min={1} max={1440} value={draft.approvalWait} onChange={(e) => setDraft({ ...draft, approvalWait: e.target.value })} className={input} /></label>
                  <label>May start late by (minutes)<input type="number" min={0} max={1440} value={draft.catchUp} onChange={(e) => setDraft({ ...draft, catchUp: e.target.value })} className={input} /></label>
                  <label>Retries after a failure<input type="number" min={0} max={3} value={draft.retryLimit} onChange={(e) => setDraft({ ...draft, retryLimit: e.target.value })} className={input} /></label>
                  <label>Retry after (minutes)<input type="number" min={1} max={1440} value={draft.retryDelay} onChange={(e) => setDraft({ ...draft, retryDelay: e.target.value })} className={input} /></label>
                  <label>Approval mode
                    <select value={draft.approvalMode} onChange={(e) => setDraft({ ...draft, approvalMode: e.target.value as ApprovalMode })} className={input}>
                      {APPROVAL_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                    </select>
                  </label>
                </div>
                <p className="mt-2 text-muted">
                  A run uses the stricter of this mode and the agent&apos;s own. When it needs your approval it waits, tells you,
                  and is denied if nobody answers within the approval wait. Time spent waiting does not count toward the run limit.
                  A failed run is started again up to the number of retries (0 turns it off); a run you stopped, one that reached
                  its run limit and one cut short by the app stopping are never retried.
                </p>
              </details>
              <div className="flex gap-2">
                <button type="submit" disabled={busy || draft.agentId === null || !canSaveSchedulePreview(draft.schedule, validPreviewKey)} className="cursor-pointer rounded-md px-3 py-1.5 text-sm disabled:opacity-50 bg-accent text-accent-fg hover:opacity-90">{busy ? "Saving…" : "Save"}</button>
                <button type="button" onClick={() => { setValidPreviewKey(null); setDraft(null); }} className="rounded-md border border-line px-3 py-1.5 text-sm">Cancel</button>
              </div>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted">
                  A routine runs a prompt as a new conversation of one of your agents, on a schedule, by webhook, or when you press Run now.
                  The backend must be running for it to run.
                </p>
                <button disabled={live.length === 0} onClick={() => { setValidPreviewKey(null); setDraft(newDraft(live)); }} className={button}>New routine</button>
              </div>
              {live.length === 0 && <p className="text-sm text-muted">Create an agent first: every routine runs as one.</p>}
              {routines === null ? <p className="text-sm text-muted">Loading…</p> : routines.length === 0 ? (
                <p className="text-sm text-muted">No routines yet.</p>
              ) : (
                <ul className="space-y-2">
                  {routines.map((routine) => {
                    const active = isActiveRun(routine.latest_run);
                    return (
                      <li key={routine.id} className="rounded-md border border-line p-3" aria-label={routine.name}>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <p className="truncate text-sm font-medium">{routine.name}</p>
                          <span className="text-xs text-muted">{agentName(routine.agent_id)}</span>
                          {routine.paused && <span className="rounded bg-hover px-1.5 text-xs">paused</span>}
                          {routine.webhook_enabled && <span className="rounded bg-hover px-1.5 text-xs">webhook</span>}
                        </div>
                        <p className="text-xs text-muted">{routine.schedule_kind === "manual" ? routine.summary : `${routine.summary} · ${nextRunText(routine)}`}</p>
                        {routine.paused_reason && <p className="text-xs text-warning">{routine.paused_reason}</p>}
                        {routine.latest_run && (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-muted">Latest:</span>
                            <State state={routine.latest_run.state} />
                            <span className="text-muted">{formatWhen(routine.latest_run.scheduled_for ?? routine.latest_run.created_at, routine.timezone)}</span>
                            {routine.latest_run.thread_id !== null && <Link href={`/chat?thread=${routine.latest_run.thread_id}`} onClick={onClose} className="underline">Open conversation</Link>}
                          </p>
                        )}
                        {secret?.routineId === routine.id && (
                          <div className="mt-2 space-y-1 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs">
                            <p className="font-medium">Copy this secret now: it is shown once.</p>
                            <p>URL: <code className="break-all">{secret.url}</code></p>
                            <p>Secret: <code className="break-all">{secret.secret}</code></p>
                            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-raised/60 p-1">{curlExample(secret.url, secret.secret)}</pre>
                            <button className={button} onClick={() => setSecret(null)}>I have copied it</button>
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1">
                          <button disabled={busy || active} title={active ? "A run is in progress" : undefined} onClick={() => void act(() => api.runRoutineNow(routine.id), "Could not start the routine.")} className={button}>Run now</button>
                          <button disabled={busy} onClick={() => void act(() => (routine.paused ? api.resumeRoutine(routine.id) : api.pauseRoutine(routine.id)), "Could not change the routine.")} className={button}>{routine.paused ? "Resume" : "Pause"}</button>
                          <button disabled={busy} onClick={() => { setValidPreviewKey(null); setDraft(draftOf(routine)); }} className={button}>Edit</button>
                          <button disabled={busy} onClick={() => setHistory(routine)} className={button}>History</button>
                          <button disabled={busy} onClick={() => void act(async () => {
                            const result = await api.enableRoutineWebhook(routine.id);
                            setSecret({ routineId: routine.id, secret: result.secret, url: webhookUrl(result.path) });
                          }, "Could not set up the webhook.")} className={button}>{routine.webhook_enabled ? "New webhook secret" : "Add webhook"}</button>
                          {routine.webhook_enabled && <button disabled={busy} onClick={() => void act(() => api.disableRoutineWebhook(routine.id), "Could not turn off the webhook.")} className={button}>Remove webhook</button>}
                          {confirmDelete === routine.id ? (
                            <>
                              <button disabled={busy} onClick={() => void act(() => api.deleteRoutine(routine.id), "Could not delete the routine.").then(() => setConfirmDelete(null))} className={`${button} text-danger`}>Delete it and its history</button>
                              <button disabled={busy} onClick={() => setConfirmDelete(null)} className={button}>Keep</button>
                            </>
                          ) : (
                            <button disabled={busy} onClick={() => setConfirmDelete(routine.id)} className={`${button} text-danger`}>Delete</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
    </Dialog>
  );
}
