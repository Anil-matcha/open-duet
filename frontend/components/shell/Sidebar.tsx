"use client";

import {
  Archive,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Columns3,
  LayoutGrid,
  Plus,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Agent, Thread } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/use-i18n";
import { agentTarget, recentVisible, rowStatus, sidebarAgents } from "@/lib/sidebar";
import { ConversationSearch } from "@/components/chat/ConversationSearch";
import { Button } from "@/components/ui/Button";
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

function CollapsibleSectionHeader({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted hover:text-ink cursor-pointer select-none transition-colors"
      >
        {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        <span>{title}</span>
        {count !== undefined && count > 0 && (
          <span className="font-normal text-[11px] text-faint">({count})</span>
        )}
      </button>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

// How many conversations Recent lists before "Show all"; anything needing attention is always listed.
const RECENT_LIMIT = 8;
// Agents listed before "Show all"; the open, lead and busy agents are always listed.
const AGENT_LIMIT = 3;

const ROW =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-field py-1.5 pl-2.5 pr-2 text-left text-sm transition-colors duration-(--dur-fast) touch:py-2.5";

// The app's left column: start a chat, search, recent conversations, agents, and external tools.
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
  agents: Agent[] | null;
  threads: Thread[] | null;
  selectedThreadId: number | null;
  selectedAgentId: number | null;
  live: SidebarLive;
  showArchived: boolean;
  onToggleArchived: () => void;
  actions: RowActions;
  error: string | null;
  onNewChat: (agentId?: number) => void;
  onManageAgents?: () => void;
  onDeleteAgent?: (agent: Agent) => void;
  onEditAgent?: (agent: Agent) => void;
  onChangeLead?: (agent: Agent, remove: boolean) => Promise<void>;
  leadAgentId?: number | null;
  onNewAgent?: () => void;
  onOpenRoutines?: () => void;
  onOpenPlanner?: () => void;
  onNavigate?: () => void;
  collaboration?: React.ReactNode;
}) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  const listed = sidebarAgents(agents);
  const [agentsCollapsed, setAgentsCollapsed] = useState(() => listed.length === 0);
  const unread = useUnread(threads, selectedThreadId);

  const names = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const shownAgents = showAllAgents
    ? listed
    : listed.filter(
        (agent, index) =>
          index < AGENT_LIMIT ||
          agent.id === selectedAgentId ||
          agent.id === leadAgentId ||
          agent.id === live.agentId
      );
  const shownThreads = recentVisible(
    threads ?? [],
    RECENT_LIMIT,
    (thread) =>
      thread.id === selectedThreadId ||
      thread.id === live.threadId ||
      unread.has(thread.id) ||
      thread.session_state === "broken",
    showAll
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
      <ConversationSearch agentNames={names} onActive={setSearching} onNavigate={onNavigate}>
        {/* 1. Recent Conversations - Front and Center */}
        <section aria-label={t("sidebar.recent")}>
          <CollapsibleSectionHeader
            title={t("sidebar.recent")}
            count={threads?.length}
            collapsed={recentCollapsed}
            onToggle={() => setRecentCollapsed((c) => !c)}
          >
            <IconButton
              label={showArchived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
              pressed={showArchived}
              onClick={onToggleArchived}
              className="size-6 touch:size-9"
            >
              <Archive size={13} />
            </IconButton>
          </CollapsibleSectionHeader>

          {!recentCollapsed && (
            <ul className="space-y-0.5 pt-0.5">
              {threads === null && (
                <li>
                  <SkeletonList rows={4} className="px-1 pt-1" />
                </li>
              )}
              {threads?.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted">
                  {showArchived ? t("sidebar.emptyArchived") : "No conversations yet."}
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
              {threads !== null && threads.length > RECENT_LIMIT && (
                <button
                  type="button"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((on) => !on)}
                  className="mt-1 w-full cursor-pointer rounded-field px-3 py-1.5 text-left text-xs font-medium text-muted hover:bg-hover/60 hover:text-ink touch:py-2.5"
                >
                  {showAll ? t("sidebar.showFewer") : t("sidebar.showAll")}
                </button>
              )}
            </ul>
          )}
        </section>

        {/* 2. Custom Agents - Collapsible */}
        {agents !== null && (
          <section aria-label={t("sidebar.agents")} className="mt-1">
            <CollapsibleSectionHeader
              title={t("sidebar.agents")}
              count={listed.length}
              collapsed={agentsCollapsed}
              onToggle={() => setAgentsCollapsed((c) => !c)}
            >
              {onNewAgent && (
                <IconButton
                  label={t("sidebar.newAgent")}
                  onClick={() => {
                    onNewAgent();
                    onNavigate?.();
                  }}
                  className="size-6 touch:size-9"
                >
                  <Plus size={13} />
                </IconButton>
              )}
              {onManageAgents && listed.length > 0 && (
                <IconButton
                  label={t("sidebar.manageAgents")}
                  onClick={() => {
                    onManageAgents();
                    onNavigate?.();
                  }}
                  className="size-6 touch:size-9"
                >
                  <SlidersHorizontal size={13} />
                </IconButton>
              )}
            </CollapsibleSectionHeader>

            {!agentsCollapsed && (
              <div className="pt-0.5">
                {listed.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onNewAgent?.();
                      onNavigate?.();
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-field px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-hover/60 hover:text-ink"
                  >
                    <Plus size={13} className="shrink-0 text-muted" />
                    <span>Create an agent</span>
                  </button>
                )}
                <ul className="space-y-0.5">
                  {shownAgents.map((agent) => {
                    const target = agentTarget(threads, agent.id);
                    return (
                      <AgentRow
                        key={agent.id}
                        agent={agent}
                        href={target.kind === "thread" ? `/chat?thread=${target.id}` : null}
                        selected={selectedAgentId === agent.id}
                        status={
                          live.agentId === agent.id
                            ? rowStatus({ working: live.working, waiting: live.waiting })
                            : null
                        }
                        isLead={leadAgentId === agent.id}
                        onOpenChat={() => newChat(agent.id)}
                        onNavigate={onNavigate}
                        onEdit={onEditAgent ? () => onEditAgent(agent) : undefined}
                        onChangeLead={
                          onChangeLead ? () => void onChangeLead(agent, leadAgentId === agent.id) : undefined
                        }
                        onDelete={onDeleteAgent ? () => onDeleteAgent(agent) : undefined}
                      />
                    );
                  })}
                </ul>
                {listed.length > AGENT_LIMIT ? (
                  <button
                    type="button"
                    aria-expanded={showAllAgents}
                    onClick={() => setShowAllAgents((on) => !on)}
                    className="mt-1 w-full cursor-pointer rounded-field px-3 py-1.5 text-left text-xs font-medium text-muted hover:bg-hover/60 hover:text-ink touch:py-2.5"
                  >
                    {showAllAgents
                      ? t("sidebar.showFewerAgents")
                      : t("sidebar.showAllAgents", { n: listed.length })}
                  </button>
                ) : null}
              </div>
            )}
          </section>
        )}

        {/* 3. Rooms and Team Collaboration */}
        {collaboration}
      </ConversationSearch>

      {error && <p role="alert" className="px-4 pb-2 text-xs text-danger">{error}</p>}

      {/* Navigation Tools & Footer */}
      <div className="mt-auto shrink-0 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="space-y-0.5">
          {onOpenPlanner && (
            <button
              type="button"
              onClick={() => {
                onOpenPlanner();
                onNavigate?.();
              }}
              className={cn(ROW, "hover:bg-hover/60")}
            >
              <Columns3 size={16} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="font-medium">Tasks & calendar</span>
            </button>
          )}
          {onOpenRoutines && (
            <button
              type="button"
              onClick={() => {
                onOpenRoutines();
                onNavigate?.();
              }}
              className={cn(ROW, "hover:bg-hover/60")}
            >
              <CalendarClock size={16} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="font-medium">{t("sidebar.routines")}</span>
            </button>
          )}
          <Link href="/apps/" className={cn(ROW, "hover:bg-hover/60")}>
            <LayoutGrid size={16} aria-hidden="true" className="shrink-0 text-muted" />
            <span className="font-medium">{t("sidebar.apps")}</span>
          </Link>
        </div>

        {/* Bottom bar with Settings and Theme Toggle */}
        <div className="mt-1.5 flex items-center justify-between border-t border-line/60 pt-1.5">
          <Link
            href="/settings/"
            onClick={onNavigate}
            title={`${t("sidebar.settings")} (⌘+, / Ctrl+,)`}
            className="flex items-center gap-2 rounded-field px-2.5 py-1 text-sm font-medium text-muted transition-colors duration-(--dur-fast) hover:bg-hover/60 hover:text-ink"
          >
            <Settings size={16} aria-hidden="true" className="shrink-0 text-muted" />
            <span>{t("sidebar.settings")}</span>
          </Link>
          <div className="pr-1">
            <ThemeToggle iconOnly />
          </div>
        </div>
      </div>
    </nav>
  );
}
