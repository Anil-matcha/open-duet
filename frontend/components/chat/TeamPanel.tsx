"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, type Agent } from "@/lib/api";
import { collaboration, type TeamState, type TeamJob } from "@/lib/collaboration";
import { useSession } from "@/components/AuthGate";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Input";
import { EmptyPanel, ErrorState, LoadingState } from "./PanelState";
import { SharedApproval } from "./SharedApproval";
import { useT } from "@/lib/use-i18n";

const BUTTON = "rounded-field border border-line px-3 py-1.5 text-sm hover:bg-hover disabled:opacity-50";

export function JobCard({ job: initial, compact = false }: { job: TeamJob; compact?: boolean }) {
  const t = useT();
  const [job, setJob] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useSession();
  const refresh = useCallback(() => collaboration.job(initial.id).then(setJob).catch(() => {}), [initial.id]);
  useEffect(() => { void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3000); return () => clearInterval(timer); }, [refresh]);
  const cancel = async () => { setBusy(true); setError(null); try { await collaboration.cancelJob(job.id); await refresh(); } catch (err) { setError(err instanceof ApiError ? err.message : t("team.stopError")); } finally { setBusy(false); } };
  return <article className="space-y-2 rounded-field border border-line bg-raised p-3 text-sm" style={{ marginLeft: compact ? undefined : `${Math.min(job.depth ?? 0, 3) * 8}px` }}>
    <div className="flex flex-wrap items-center gap-2"><strong>{t("team.job", { id: job.id })}</strong><span className="text-xs text-muted">{job.mode} · {job.status}{job.outcome ? ` · ${job.outcome}` : ""}</span></div>
    <p className="whitespace-pre-wrap break-words">{job.brief}</p>
    {job.result && <details><summary className="cursor-pointer text-xs underline">{t("team.result")}</summary><p className="mt-2 whitespace-pre-wrap break-words">{job.result}</p></details>}
    {job.outcome_detail && <p className="text-xs text-warning">{job.outcome_detail}</p>}
    <div className="flex flex-wrap gap-2">{job.assignee_thread_id && <Link className={BUTTON} href={`/chat?thread=${job.assignee_thread_id}`}>{t("team.openWork")}</Link>}{["queued", "running", "needs_input", "waiting", "resume"].includes(job.status) && session?.scopes.includes("admin") && <button type="button" className={BUTTON} disabled={busy} onClick={() => void cancel()}>{t("team.stopJob")}</button>}</div>
    {job.approvals?.filter(item => item.status === "pending").map(approval => <SharedApproval key={approval.id} approval={approval} onChanged={() => void refresh()} />)}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </article>;
}

export function TeamPanel({ agents, onClose, onChanged }: { agents: Agent[]; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const [data, setData] = useState<TeamState | null>(null);
  const [jobs, setJobs] = useState<TeamJob[]>([]);
  const [activity, setActivity] = useState<{ id: number; kind: string; created_at: string }[]>([]);
  const [tab, setTab] = useState("agents");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useSession();
  const admin = session?.scopes.includes("admin") === true;
  const refresh = useCallback(async () => {
    try { const [team, list] = await Promise.all([collaboration.team(), collaboration.jobs()]); setData(team); setJobs(list); if (admin) setActivity(await collaboration.activity()); }
    catch (err) { setError(err instanceof ApiError ? err.message : t("team.loadError")); }
  }, [admin, t]);
  useEffect(() => { const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [refresh]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); await refresh(); onChanged(); } catch (err) { setError(err instanceof ApiError ? err.message : t("team.updateError")); } finally { setBusy(false); } };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} title={data?.team?.name ?? t("team.title")} description={t("team.description")} size="lg">
    <div className="space-y-4"><div className="flex gap-2" role="tablist" aria-label={t("team.title")}>{["agents", "activity"].map(value => <button key={value} role="tab" aria-selected={tab === value} className={BUTTON} onClick={() => setTab(value)}>{value === "agents" ? t("team.agentsTab") : t("team.activityTab")}</button>)}</div>
      {error && <ErrorState message={error} onRetry={() => { setError(null); void refresh(); }} />}
      {!data && !error && <LoadingState rows={3} />}
      {data && tab === "agents" && <div className="space-y-3">{!data.team && <EmptyPanel title={t("team.noTeam")} description={t("team.noTeamHelp")} />}{data.team && !data.lead_ready.ok && <p className="text-sm text-warning">{data.lead_ready.reason}</p>}
        {data.agents.map(agent => <article key={agent.id} className="space-y-2 rounded-field border border-line p-3"><div><strong>{agent.name}</strong>{agent.is_lead && <Badge tone="accent" className="ml-2">{t("agentTeam.leadBadge")}</Badge>}<span className="ml-2 text-xs text-muted">{agent.state}</span></div><p className="text-xs text-muted">{agent.created_by_agent_id ? t(agent.instructions_reviewed ? "team.instructionsReviewed" : "team.instructionsReview", { id: agent.created_by_agent_id }) : t("team.addedByYou")}</p>
          {admin && <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={agent.delegation_enabled} onChange={event => void act(() => collaboration.delegation(agent.id, event.target.checked))} />{t("team.canDelegate")}</label>{!agent.is_lead && <><button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.lead(agent.id))}>{t("team.makeLead")}</button><button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.removeMember(agent.id))}>{t("team.removeMember")}</button></>}{agent.created_by_agent_id && <button className={BUTTON} disabled={busy} onClick={() => void act(() => collaboration.undoCreate(agent.id))}>{t("team.undoCreation")}</button>}</div>}
        </article>)}
        {admin && <label className="block text-sm">{data.team ? t("team.addAgent") : t("team.chooseLead")}<Select className="mt-1" value="" disabled={busy} onChange={event => { const id = Number(event.target.value); if (id) void act(() => data.team ? collaboration.addMember(id) : collaboration.lead(id)); }}><option value="">{t("team.selectAgent")}</option>{agents.filter(agent => !data.agents.some(member => member.id === agent.id) && !agent.archived_at).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></label>}
      </div>}
      {tab === "activity" && <div className="space-y-3">{jobs.length === 0 && <EmptyPanel title={t("team.noJobs")} description={t("team.noJobsHelp")} />}{jobs.map(job => <JobCard key={job.id} job={job} />)}{activity.length > 0 && <details><summary className="cursor-pointer text-sm">{t("team.activity")}</summary><ol className="mt-2 space-y-1 text-xs text-muted">{activity.map(item => <li key={item.id}>{item.kind.replaceAll("_", " ")} · {new Date(item.created_at).toLocaleString()}</li>)}</ol></details>}</div>}
    </div>
  </Dialog>;
}
