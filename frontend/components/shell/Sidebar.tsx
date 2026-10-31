"use client";

import { Archive, CalendarClock, Columns3, LayoutGrid, Plus, Send, Settings, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Agent, Thread } from "@/lib/api";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { agentTarget, recentVisible, rowStatus, sidebarAgents } from "@/lib/sidebar";
import { ConversationSearch } from "@/components/chat/ConversationSearch";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { SkeletonList } from "@/components/ui/Skeleton";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { AgentRow } from "./AgentRow";
import { ThreadRow, type RowActions } from "./ThreadRow";
import { useUnread } from "./useUnread";

export type SidebarLive = {
  // The open conversation and its agent are the only ones whose live state this page knows.
  threadId: number | null;
  agentId: number | null;
  working: boolean;
  waiting: boolean;
};

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

// How many conversations Recent lists before "Show all"; anything needing attention is always listed.
const RECENT_LIMIT = 8;

const ROW = "flex w-full cursor-pointer items-center gap-2.5 rounded-field py-2 pl-2 pr-2 text-left text-sm transition-colors duration-(--dur-fast) touch:py-2.5";

// The app's left column: start a chat, search, the agents, every recent conversation, and the
// places that are not conversations. Agents and Recent are separate views of the same
// conversations; nothing is nested under an agent.
export function Sidebar({
  agents,
  threads,
  selectedThreadId,
  selectedAgentId,
  live,
  showArchived,
  onToggleArchived,
  actions,
  error,
  onNewChat,
  onManageAgents,
  onDeleteAgent,
  onEditAgent,
  onChangeLead,
  leadAgentId = null,
  onNewAgent,
  onOpenRoutines,
  onOpenPlanner,
  onNavigate,
  collaboration,
}: {
  // null: the backend has no agents (an older one), so the section is left out.
  agents: Agent[] | null;
  // null while the first load is under way.
  threads: Thread[] | null;
  selectedThreadId: number | null;
  // The agent the open or about-to-start conversation belongs to.
  selectedAgentId: number | null;
  live: SidebarLive;
  showArchived: boolean;
  onToggleArchived: () => void;
  actions: RowActions;
  // What went wrong with the last rename, archive or delete, if anything.
  error: string | null;
  // Start a conversation: with the given agent, or (no argument) with whatever is chosen now.
  onNewChat: (agentId?: number) => void;
  onManageAgents?: () => void;
  onDeleteAgent?: (agent: Agent) => void;
  onEditAgent?: (agent: Agent) => void;
  onChangeLead?: (agent: Agent, remove: boolean) => Promise<void>;
  leadAgentId?: number | null;
  // Open the new-agent form. Offered even when there are no agents yet.
  onNewAgent?: () => void;
  onOpenRoutines?: () => void;
  onOpenPlanner?: () => void;
  // Lets a drawer close itself after a choice.
  onNavigate?: () => void;
  collaboration?: React.ReactNode;
}) {
  const [searching, setSearching] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const unread = useUnread(threads, selectedThreadId);
  const names = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const listed = sidebarAgents(agents);
  const shownThreads = recentVisible(
    threads ?? [],
    RECENT_LIMIT,
    (thread) => thread.id === selectedThreadId || thread.id === live.threadId || unread.has(thread.id) || thread.session_state === "broken",
    showAll,
  );

  const newChat = (agentId?: number) => {
    onNewChat(agentId);
    onNavigate?.();
  };

  return (
    <nav aria-label={t("shell.conversations")} className="flex h-full min-h-0 flex-col bg-surface text-ink">
      <div className="space-y-2 p-3 pb-1">
        <Button className="w-full" icon={<Plus size={16} aria-hidden="true" />} onClick={() => newChat()}>
          {t("shell.newChat")}
        </Button>
      </div>
      <ConversationSearch agentNames={names} onActive={setSearching} onNavigate={onNavigate} />

      <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 pb-2", searching && "hidden")}>
        {agents !== null && (
          <section aria-label={t("sidebar.agents")}>
            <SectionHeader title={t("sidebar.agents")}>
              {onNewAgent && (
                <IconButton label={t("sidebar.newAgent")} onClick={() => { onNewAgent(); onNavigate?.(); }} className="size-7 touch:size-10">
                  <Plus size={14} />
                </IconButton>
              )}
              {onManageAgents && listed.length > 0 && (
                <IconButton label={t("sidebar.manageAgents")} onClick={() => { onManageAgents(); onNavigate?.(); }} className="size-7 touch:size-10">
                  <SlidersHorizontal size={14} />
                </IconButton>
              )}
            </SectionHeader>
            {listed.length === 0 && (
              <EmptyState
                compact
                title={t("sidebar.noAgentsTitle")}
                description={t("sidebar.noAgents")}
                action={onNewAgent ? (
                  <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => { onNewAgent(); onNavigate?.(); }}>
                    {t("sidebar.newAgent")}
                  </Button>
                ) : undefined}
              />
            )}
            <ul className="space-y-0.5">
              {listed.map((agent) => {
                const target = agentTarget(threads, agent.id);
                return (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    href={target.kind === "thread" ? `/chat?thread=${target.id}` : null}
                    selected={selectedAgentId === agent.id}
                    status={live.agentId === agent.id ? rowStatus({ working: live.working, waiting: live.waiting }) : null}
                    isLead={leadAgentId === agent.id}
                    onOpenChat={() => newChat(agent.id)}
                    onNavigate={onNavigate}
                    onEdit={onEditAgent ? () => onEditAgent(agent) : undefined}
                    onChangeLead={onChangeLead ? () => void onChangeLead(agent, leadAgentId === agent.id) : undefined}
                    onDelete={onDeleteAgent ? () => onDeleteAgent(agent) : undefined}
                  />
                );
              })}
            </ul>
          </section>
        )}

        {collaboration}

        <section aria-label={t("sidebar.recent")}>
          <SectionHeader title={t("sidebar.recent")}>
            <IconButton
              label={showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
              pressed={showArchived}
              onClick={onToggleArchived}
              className="size-7 touch:size-10"
            >
              <Archive size={14} />
            </IconButton>
          </SectionHeader>
          <ul className="space-y-0.5">
            {threads === null && (
              <li><SkeletonList rows={5} className="px-1 pt-1" /></li>
            )}
            {threads?.length === 0 && (
              <li>
                <EmptyState
                  compact
                  title={showArchived ? t("sidebar.emptyArchived") : t("sidebar.emptyTitle")}
                  description={showArchived ? undefined : t("sidebar.empty")}
                />
              </li>
            )}
            {shownThreads.map((thread) => {
              const open = thread.id === live.threadId;
              return (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  selected={thread.id === selectedThreadId}
                  agentName={thread.agent_id != null ? names.get(thread.agent_id) : undefined}
                  status={open ? { working: live.working, waiting: live.waiting } : {}}
                  unread={unread.has(thread.id)}
                  actions={actions}
                  onNavigate={onNavigate}
                />
              );
            })}
          </ul>
          {threads !== null && threads.length > RECENT_LIMIT && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((on) => !on)}
              className="mt-1 w-full cursor-pointer rounded-field px-3 py-2 text-left text-xs font-medium text-muted hover:bg-hover/60 hover:text-ink touch:py-3"
            >
              {showAll ? t("sidebar.showFewer") : t("sidebar.showAll")}
            </button>
          )}
        </section>
      </div>

      {error && <p role="alert" className="px-4 pb-2 text-xs text-danger">{error}</p>}

      <div className="space-y-0.5 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {onOpenPlanner && (
          <button type="button" onClick={() => { onOpenPlanner(); onNavigate?.(); }} className={cn(ROW, "hover:bg-hover/60")}>
            <Columns3 size={16} aria-hidden="true" />
            <span className="font-medium">Tasks & calendar</span>
          </button>
        )}
        {onOpenRoutines && (
          <button type="button" onClick={() => { onOpenRoutines(); onNavigate?.(); }} className={cn(ROW, "hover:bg-hover/60")}>
            <CalendarClock size={18} aria-hidden="true" className="shrink-0 text-muted" />
            <span className="font-medium">{t("sidebar.routines")}</span>
          </button>
        )}
        <Link href="/apps/" className={cn(ROW, "hover:bg-hover/60")}>
          <LayoutGrid size={18} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="font-medium">{t("sidebar.apps")}</span>
        </Link>
        <Link href="/tasks/" className={cn(ROW, "hover:bg-hover/60")}>
          <Send size={18} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="font-medium">{t("sidebar.legacyTasks")}</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link href="/settings/" className={cn(ROW, "flex-1 hover:bg-hover/60")}>
            <Settings size={18} aria-hidden="true" className="shrink-0 text-muted" />
            <span className="font-medium">{t("sidebar.settings")}</span>
          </Link>
          <ThemeToggle iconOnly />
        </div>
      </div>
    </nav>
  );
}
