"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Clock3, GitBranch, Hash, Users } from "lucide-react";
import { ApiError, type Agent } from "@/lib/api";
import { collaboration, type Room, type TeamAgent, type TeamJob, type TeamState } from "@/lib/collaboration";
import { useSession } from "@/components/AuthGate";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Input";
import { EmptyPanel, ErrorState, LoadingState } from "./PanelState";
import { SharedApproval } from "./SharedApproval";
import { roomHref } from "@/lib/rooms";
import { useT } from "@/lib/use-i18n";

const BUTTON = "rounded-field border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50";
const LIVE = new Set(["queued", "running", "needs_input", "waiting", "resume"]);
type TeamTab = "agents" | "work" | "rooms";
type WorkFilter = "all" | "attention" | "running" | "waiting" | "finished";
const FILTERS: WorkFilter[] = ["all", "attention", "running", "waiting", "finished"];
const FILTER_LABEL: Record<WorkFilter, string> = {
  all: "team.allWork",
  attention: "team.needsAttention",
  running: "team.runningWork",
  waiting: "team.waitingWork",
  finished: "team.finishedWork",
};

function jobGroup(job: TeamJob): Exclude<WorkFilter, "all"> {
  if (job.status === "needs_input" || job.status === "failed") return "attention";
  if (job.status === "queued" || job.status === "running") return "running";
  if (job.status === "waiting" || job.status === "resume") return "waiting";
  return "finished";
}

function jobTone(status: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "needs_input") return "warning";
  if (status === "running" || status === "resume") return "accent";
  if (status === "cancelled") return "neutral";
  return "neutral";
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function elapsed(value: string, now: number): string {
  const start = new Date(value).valueOf();
  if (Number.isNaN(start)) return "—";
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function agentName(agents: TeamAgent[], id: number): string {
  if (id <= 0) return "—";
  return agents.find((agent) => agent.id === id)?.name ?? `Agent ${id}`;
}

export function JobCard({ job: initial, agents, onChanged }: { job: TeamJob; agents: TeamAgent[]; onChanged: () => void }) {
  const t = useT();
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { session } = useSession();
  const admin = session?.scopes.includes("admin") === true;
  const requester = agentName(agents, job.requester_agent_id);
  const assignee = agentName(agents, job.assignee_agent_id);
  const refresh = useCallback(() => collaboration.job(initial.id).then(setJob).catch(() => {}), [initial.id]);

  useEffect(() => {
    void refresh();
    if (!LIVE.has(initial.status)) return;
    const timer = setInterval(() => {
      if (!document.hidden) {
        setNow(Date.now());
        void refresh();
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [initial.status, refresh]);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await collaboration.cancelJob(job.id);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("team.stopError"));
    } finally {
      setBusy(false);
    }
  };

  const running = LIVE.has(job.status);
  const durationStart = job.started_at ?? job.created_at;
  const pendingApprovals = job.approvals?.filter((item) => item.status === "pending") ?? [];

  return (
    <article
      className="relative space-y-3 rounded-card border border-line bg-raised p-4 text-sm"
      style={{ marginLeft: job.depth > 1 ? `${Math.min(job.depth - 1, 3) * 12}px` : undefined }}
    >
      {job.depth > 1 && <span className="absolute -left-3 top-0 bottom-0 border-l border-line" aria-hidden="true" />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{t("team.job", { id: job.id })}</strong>
            <Badge tone={jobTone(job.status)}>{job.status.replaceAll("_", " ")}</Badge>
            <Badge>{job.mode}</Badge>
            {job.outcome && <Badge>{job.outcome.replaceAll("_", " ")}</Badge>}
            {job.parent_id !== null && <span className="inline-flex items-center gap-1 text-xs text-muted"><GitBranch size={13} aria-hidden="true" />{t("team.job", { id: job.parent_id })}</span>}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-ink">{job.brief}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted" aria-label={running ? `${t("team.elapsed")} ${elapsed(durationStart, now)}` : undefined}>
          <Clock3 size={14} aria-hidden="true" />
          {running ? <><span>{t("team.elapsed")}</span><time>{elapsed(durationStart, now)}</time></> : job.finished_at ? <time>{displayTime(job.finished_at)}</time> : <time>{displayTime(job.created_at)}</time>}
        </div>
      </div>

      <div className="grid items-center gap-2 rounded-field bg-inset/60 px-3 py-2 text-xs sm:grid-cols-[1fr_auto_1fr]">
        <div>
          <span className="text-muted">{t("team.requestedBy")}</span>
          <span className="ml-1 font-medium">{requester}</span>
        </div>
        <ArrowRight className="hidden text-muted sm:block" size={14} aria-hidden="true" />
        <div>
          <span className="text-muted">{t("team.assignedTo")}</span>
          <span className="ml-1 font-medium">{assignee}</span>
        </div>
      </div>

      {(job.started_at || job.finished_at) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {job.started_at && <span>{t("team.startedAt")} · {displayTime(job.started_at)}</span>}
          {job.finished_at && <span>{t("team.finishedAt")} · {displayTime(job.finished_at)}</span>}
        </div>
      )}

      {job.question && <p className="rounded-field border border-warning/40 bg-warning/5 px-3 py-2 text-sm">{job.question}</p>}
      {job.outcome_detail && <p className="text-xs text-warning">{job.outcome_detail}</p>}

      {job.result && (
        <details className="rounded-field border border-line px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium underline">{t("team.result")}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{job.result}</p>
        </details>
      )}

      {pendingApprovals.length > 0 && (
        <div className="space-y-2">
          {pendingApprovals.map((approval) => <SharedApproval key={approval.id} approval={approval} onChanged={() => void refresh()} />)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {job.requester_thread_id && <Link className={BUTTON} href={`/chat?thread=${job.requester_thread_id}`}>{t("team.requestedBy")}: {requester}</Link>}
        {job.assignee_thread_id && <Link className={BUTTON} href={`/chat?thread=${job.assignee_thread_id}`}>{t("team.openWork")}: {assignee}</Link>}
        {running && admin && <button type="button" className={BUTTON} disabled={busy} onClick={() => void cancel()}>{t("team.stopJob")}</button>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </article>
  );
}

export function TeamPanel({ agents, onClose, onChanged }: { agents: Agent[]; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const [data, setData] = useState<TeamState | null>(null);
  const [jobs, setJobs] = useState<TeamJob[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activity, setActivity] = useState<{ id: number; kind: string; job_id?: number; thread_id?: number; created_at: string }[]>([]);
  const [tab, setTab] = useState<TeamTab>("agents");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useSession();
  const admin = session?.scopes.includes("admin") === true;

  const refresh = useCallback(async () => {
    try {
      const [team, list, roomList] = await Promise.all([
        collaboration.team(),
        collaboration.jobs(),
        collaboration.rooms().catch(() => [] as Room[]),
      ]);
      setData(team);
      setJobs(list);
      setRooms(roomList);
      setError(null);
      if (admin) setActivity(await collaboration.activity());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("team.loadError"));
    }
  }, [admin, t]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("team.updateError"));
    } finally {
      setBusy(false);
    }
  };

  const teamAgents = useMemo(() => {
    const roster = data?.agents ?? [];
    return [...roster].sort((left, right) => Number(right.is_lead) - Number(left.is_lead) || left.name.localeCompare(right.name));
  }, [data?.agents]);
  const matchingJobs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return jobs
      .filter((job) => filter === "all" || jobGroup(job) === filter)
      .filter((job) => {
        if (!normalized) return true;
        const haystack = [job.brief, job.status, job.outcome, agentName(teamAgents, job.requester_agent_id), agentName(teamAgents, job.assignee_agent_id)].join(" ").toLocaleLowerCase();
        return haystack.includes(normalized);
      })
      .sort((left, right) => new Date(right.created_at).valueOf() - new Date(left.created_at).valueOf());
  }, [filter, jobs, query, teamAgents]);
  const counts = useMemo(() => ({
    attention: jobs.filter((job) => jobGroup(job) === "attention").length,
    running: jobs.filter((job) => jobGroup(job) === "running").length,
    waiting: jobs.filter((job) => jobGroup(job) === "waiting").length,
    finished: jobs.filter((job) => jobGroup(job) === "finished").length,
  }), [jobs]);

  const visibleGroups: Exclude<WorkFilter, "all">[] = filter === "all" ? ["attention", "running", "waiting", "finished"] : [filter];
  const groupJobs = (group: Exclude<WorkFilter, "all">) => matchingJobs.filter((job) => jobGroup(job) === group);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={data?.team?.name ?? t("team.title")} description={t("team.description")} size="workspace" flush>
      <div className="flex min-h-0 flex-1 flex-col">
        <nav aria-label={t("team.title")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 sm:px-6">
          {(["agents", "work", "rooms"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              className={`min-h-12 whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${tab === value ? "border-accent font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
              onClick={() => setTab(value)}
            >
              {value === "agents" ? t("team.agentsTab") : value === "work" ? t("team.workTab") : t("room.plural")}
            </button>
          ))}
        </nav>

        {error && <div className="px-4 pt-4 sm:px-6"><ErrorState message={error} onRetry={() => { setError(null); void refresh(); }} /></div>}
        {!data && !error && <div className="p-5"><LoadingState rows={4} /></div>}

        {data && tab === "agents" && (
          <section aria-label={t("team.agentsTab")} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-5xl space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-card border border-line bg-inset/60 p-4"><span className="text-xs text-muted">{t("team.agentsTab")}</span><div className="mt-1 text-2xl font-semibold">{teamAgents.length}</div></div>
                <div className="rounded-card border border-line bg-inset/60 p-4"><span className="text-xs text-muted">{t("team.allWork")}</span><div className="mt-1 text-2xl font-semibold">{jobs.length}</div></div>
                <div className="rounded-card border border-line bg-inset/60 p-4"><span className="text-xs text-muted">{t("team.needsAttention")}</span><div className="mt-1 text-2xl font-semibold">{counts.attention}</div></div>
              </div>

              {!data.team && <EmptyPanel title={t("team.noTeam")} description={t("team.noTeamHelp")} />}
              {data.team && !data.lead_ready.ok && <p className="rounded-field border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning">{data.lead_ready.reason}</p>}

              {teamAgents.length > 0 && (
                <section aria-label={t("team.agentsTab")} className="space-y-3">
                  <h2 className="text-sm font-semibold">{t("team.agentsTab")}</h2>
                  {teamAgents.map((agent) => (
                    <article key={agent.id} className="space-y-3 rounded-card border border-line bg-raised p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"><Users size={18} aria-hidden="true" /></span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2"><strong>{agent.name}</strong>{agent.is_lead && <Badge tone="accent">{t("agentTeam.leadBadge")}</Badge>}</div>
                            {agent.title && <p className="mt-0.5 text-xs text-muted">{agent.title}</p>}
                            <p className="mt-0.5 text-xs text-muted">{[agent.provider, agent.model].filter(Boolean).join(" · ")}</p>
                          </div>
                        </div>
                        <Badge tone={agent.state === "waiting_on_you" ? "warning" : agent.state === "working" ? "accent" : "neutral"}>{agent.state.replaceAll("_", " ")}</Badge>
                      </div>
                      <p className="text-xs text-muted">{agent.created_by_agent_id ? t(agent.instructions_reviewed ? "team.instructionsReviewed" : "team.instructionsReview", { id: agent.created_by_agent_id }) : t("team.addedByYou")}</p>
                      {admin && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={agent.delegation_enabled} onChange={(event) => void act(() => collaboration.delegation(agent.id, event.target.checked))} />{t("team.canDelegate")}</label>
                          {!agent.is_lead && <><button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.lead(agent.id))}>{t("team.makeLead")}</button><button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.removeMember(agent.id))}>{t("team.removeMember")}</button></>}
                          {agent.created_by_agent_id && <button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.undoCreate(agent.id))}>{t("team.undoCreation")}</button>}
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              )}

              {admin && (
                <label className="block max-w-md text-sm">
                  {data.team ? t("team.addAgent") : t("team.chooseLead")}
                  <Select className="mt-1" value="" disabled={busy} onChange={(event) => { const id = Number(event.target.value); if (id) void act(() => data.team ? collaboration.addMember(id) : collaboration.lead(id)); }}>
                    <option value="">{t("team.selectAgent")}</option>
                    {agents.filter((agent) => !teamAgents.some((member) => member.id === agent.id) && !agent.archived_at).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </Select>
                </label>
              )}
            </div>
          </section>
        )}

        {data && tab === "work" && (
          <section aria-label={t("team.workTab")} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-5xl space-y-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {(["attention", "running", "waiting", "finished"] as const).map((group) => (
                  <button key={group} type="button" className="rounded-card border border-line bg-inset/60 p-3 text-left hover:bg-hover" onClick={() => setFilter(group)}>
                    <span className="text-xs text-muted">{t(FILTER_LABEL[group])}</span><span className="mt-1 block text-2xl font-semibold">{counts[group]}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap gap-1" aria-label={t("team.allWork")}>
                    {FILTERS.map((value) => <button key={value} type="button" aria-pressed={filter === value} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors ${filter === value ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-hover"}`} onClick={() => setFilter(value)}>{t(FILTER_LABEL[value])}</button>)}
                  </div>
                  <label className="block w-full lg:max-w-xs">
                    <span className="sr-only">{t("team.allWork")}</span>
                    <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full rounded-field border border-line bg-raised px-3 py-2 text-sm" placeholder={t("team.allWork")} />
                  </label>
                </div>

                {jobs.length === 0 && <EmptyPanel title={t("team.noJobs")} description={t("team.noJobsHelp")} />}
                {jobs.length > 0 && matchingJobs.length === 0 && <EmptyPanel title={t("team.noMatchingJobs")} />}
                {visibleGroups.map((group) => {
                  const groupRows = groupJobs(group);
                  if (groupRows.length === 0) return null;
                  return (
                    <section key={group} aria-label={t(FILTER_LABEL[group])} className="space-y-3">
                      <h2 className="flex items-center gap-2 text-sm font-semibold"><span>{t(FILTER_LABEL[group])}</span><Badge>{groupRows.length}</Badge></h2>
                      {groupRows.map((job) => <JobCard key={job.id} job={job} agents={teamAgents} onChanged={() => void refresh()} />)}
                    </section>
                  );
                })}
              </div>

              {activity.length > 0 && (
                <details className="rounded-card border border-line p-4">
                  <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Activity size={15} aria-hidden="true" />{t("team.activity")}</summary>
                  <ol className="mt-3 space-y-2">
                    {activity.map((item) => {
                      const relatedJob = item.job_id ? jobs.find((job) => job.id === item.job_id) : undefined;
                      const threadId = item.thread_id ?? relatedJob?.assignee_thread_id;
                      return <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-2 text-xs"><span>{item.kind.replaceAll("_", " ")}{item.job_id ? ` · ${t("team.job", { id: item.job_id })}` : ""}</span><div className="flex items-center gap-3"><time className="shrink-0 text-muted">{displayTime(item.created_at)}</time>{threadId && <Link className="underline" href={`/chat?thread=${threadId}`}>{t("team.openWork")}</Link>}</div></li>;
                    })}
                  </ol>
                </details>
              )}
            </div>
          </section>
        )}

        {data && tab === "rooms" && (
          <section aria-label={t("room.plural")} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-5xl space-y-3">
              {rooms.length === 0 && <EmptyPanel title={t("room.noRooms")} description={t("room.description")} />}
              {rooms.map((room) => (
                <Link key={room.id} href={roomHref(room.id)} onClick={onClose} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-raised p-4 transition-colors hover:bg-hover">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"><Hash size={17} aria-hidden="true" /></span>
                    <div className="min-w-0">
                      <strong className="block truncate">{room.name}</strong>
                      <p className="mt-1 text-xs text-muted">{room.members.map((member) => member.name).join(", ")}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    {room.dispatches.some((dispatch) => dispatch.status === "running") && <Badge tone="accent">{t("room.working")}</Badge>}
                    {room.unread > 0 && <Badge tone="warning">{t("room.unread", { count: room.unread })}</Badge>}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
