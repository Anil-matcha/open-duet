"use client";

import Link from "next/link";
import { RefreshCw, X } from "lucide-react";
import { useVersionUpdate } from "@/lib/use-version-update";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError, isLaunchTokenMissing, type Agent, type Engine, type LocalStatus, type NotificationPreferences, type Thread } from "@/lib/api";
import { notifyApprovalNeeded, notifyTurnCompletion } from "@/lib/desktop-notifications";
import { activeAgents, approvalModeLabel, modelLabel } from "@/lib/agents";
import { pendingApprovals, type NeedsYouItem } from "@/lib/transcript";
import { attachmentProblem, conversationUsage, formatCost, formatTokens, MAX_ATTACHMENTS } from "@/lib/everyday";
import { FilesPanel } from "./FilesPanel";
import { UsageView } from "./UsagePanel";
import { SkillsPanel } from "./SkillsPanel";
import { Inspector } from "@/components/shell/Inspector";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { computerChip } from "@/lib/computers";
import { AgentsPanel } from "./AgentsPanel";
import { NotificationBell } from "./NotificationBell";
import { LanguageSelect } from "@/components/settings/LanguageSelect";
import { RoutinesPanel } from "./RoutinesPanel";
import { PlannerPanel } from "./PlannerPanel";
import { EngineModelFields } from "./EngineModelFields";
import { ComputerView } from "./ComputerPanel";
import { ApprovalsPanel } from "@/components/approvals/ApprovalsPanel";
import type { Remembered } from "./items";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { NeedsYouCard } from "./NeedsYouCard";
import { ChatHeader } from "./ChatHeader";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { Sidebar } from "@/components/shell/Sidebar";
import { Drawer } from "@/components/ui/Drawer";
import { SIDEBAR_AND_PANEL_FIT, SIDEBAR_INLINE, useMediaQuery } from "@/lib/use-media-query";
import { useT } from "@/lib/use-i18n";
import { reportPresence } from "@/lib/presence";
import { readCachedPreference, resolveEngineModel, writeCachedPreference } from "@/lib/engine-selection";
import { EMPTY_QUEUED_FOLLOW_UPS, loadQueuedFollowUps, MAX_FOLLOW_UP_TEXT_CHARS, MAX_QUEUED_FOLLOW_UPS, newQueuedFollowUp, saveQueuedFollowUps, subscribeQueuedFollowUps, type QueuedFollowUp } from "@/lib/queued-follow-ups";
import { chatHref, parsePanel, type Panel } from "@/lib/panel";
import { parseSkillCommand, skillErrorText, toggleSkill, learnableTurn, type SkillSummary, type SkillLearnSource } from "@/lib/skills";
import { RoomList } from "./RoomList";
import { RoomView } from "./RoomView";
import { collaboration, type TeamState } from "@/lib/collaboration";
import { useSession } from "@/components/AuthGate";
import { onboarding } from "@/lib/onboarding";
import { TeamPanel } from "./TeamPanel";
import { parseRoom, roomHref } from "@/lib/rooms";
import { useThreadStream } from "./useThreadStream";
import type { NeedsYouSnapshot } from "@/lib/needs-you";

const LIST_REFRESH_MS = 15_000;
const COMPUTER_STATUS_REFRESH_MS = 15_000;
const emptyQueuedFollowUpsSnapshot = () => EMPTY_QUEUED_FOLLOW_UPS;

type Gate =
  | { phase: "loading" }
  | { phase: "unreachable" }
  // The backend wants the desktop app's launch token: this page is not in the app's window.
  | { phase: "locked" }
  | { phase: "ready"; status: LocalStatus };

function parseThreadId(raw: string | null): number | null {
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

// What went wrong with a rename, archive or delete, in words a person can act on.
function manageErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "turn_running") return "Stop the running answer first.";
    return err.message || "That did not work.";
  }
  return "Could not reach the backend.";
}

// Says what went wrong in words a person can act on.
// A typed `/name` adds that skill to the ones already picked, within the limit.
function toggleSkillOn(chosen: string[], name: string): string[] {
  return chosen.includes(name) ? chosen : toggleSkill(chosen, name);
}

function sendErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "skill_unavailable") return skillErrorText(err);
    if (err.code === "turn_running") return "An answer to the last message is still running.";
    if (err.code === "session_broken")
      return "The engine can no longer find this conversation. Start a new session to continue.";
    return err.message || "Could not send the message.";
  }
  return "Could not reach the backend.";
}

function Notice({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <section className="max-w-md rounded-card border border-line bg-raised p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-1 text-sm text-muted">{children}</div>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-3 cursor-pointer rounded-field border border-line px-3 py-1.5 text-sm font-medium hover:bg-hover"
          >
            {action.label}
          </button>
        )}
      </section>
    </div>
  );
}

// The chat: a list of conversations and one conversation, on the durable threads
// API. The page keeps nothing that matters: every conversation lives in the
// backend, and the open one is replayed from its stored events.
export function ChatApp() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const threadId = parseThreadId(params.get("thread"));
  const roomId = parseRoom(params.get("room"));
  const [teamOpen, setTeamOpen] = useState(false);
  const [roomTitle, setRoomTitle] = useState<{ id: number | "new"; name: string } | null>(null);
  const updateRoomTitle = useCallback((name: string) => {
    if (roomId === null) return;
    setRoomTitle(current => current?.id === roomId && current.name === name ? current : { id: roomId, name });
  }, [roomId]);
  const [teamState, setTeamState] = useState<TeamState | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const { session } = useSession();

  const [gate, setGate] = useState<Gate>({ phase: "loading" });
  // Bumped by "Check again": Claude may have been installed or signed in since.
  const [statusTick, setStatusTick] = useState(0);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [openedThread, setOpenedThread] = useState<Thread | null>(null);
  // Bumped to ask for a fresh thread list (after a send, a reset, a poll).
  const [listTick, setListTick] = useState(0);
  // Below the sidebar breakpoint the conversation list is a drawer.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarInline = useMediaQuery(SIDEBAR_INLINE);
  const inspectorInline = useMediaQuery(SIDEBAR_AND_PANEL_FIT);
  // The right-hand inspector page, kept in the address (?panel=usage) so a reload reopens it.
  const panel = parsePanel(params.get("panel"));
  const setPanel = (next: Panel | null) => router.replace(chatHref(params.toString(), next));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const subscribeToThreadQueue = useCallback(
    (subscriber: () => void) => threadId === null ? () => {} : subscribeQueuedFollowUps(threadId, subscriber),
    [threadId],
  );
  const getThreadQueue = useCallback(
    () => threadId === null ? EMPTY_QUEUED_FOLLOW_UPS : loadQueuedFollowUps(threadId),
    [threadId],
  );
  const threadQueuedFollowUps = useSyncExternalStore(
    subscribeToThreadQueue,
    getThreadQueue,
    emptyQueuedFollowUpsSnapshot,
  );
  const currentThreadIdRef = useRef(threadId);
  useEffect(() => { currentThreadIdRef.current = threadId; }, [threadId]);
  const queuedDrainRef = useRef(false);
  const [queuedTurn, setQueuedTurn] = useState<{ threadId: number; turnId: number } | null>(null);
  const [queuedSending, setQueuedSending] = useState(false);
  const [failedQueued, setFailedQueued] = useState<{ threadId: number; id: string } | null>(null);
  const [focusComposer, setFocusComposer] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  // The turn Stop was pressed for; cleared by the turn ending, which is what
  // the button waits for.
  const [stoppingTurn, setStoppingTurn] = useState<number | null>(null);
  // Named agents. null: the backend has none to offer (an older one answers 404),
  // and the page behaves as before.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const firstAgentRedirecting = useRef(false);
  const [agentTick, setAgentTick] = useState(0);
  const [agentsShown, setAgentsShown] = useState(false);
  const agentsOpen = agentsShown || params.get("view") === "agents";
  const setAgentsOpen = useCallback((open: boolean) => {
    setAgentsShown(open);
    if (!open && params.get("view") === "agents") {
      const query = new URLSearchParams(params.toString());
      query.delete("view");
      router.replace(query.toString() ? `/chat?${query.toString()}` : "/chat");
    }
  }, [params, router]);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<Agent | null>(null);
  // The Agents panel opened from New agent starts on the form.
  const [agentsCreate, setAgentsCreate] = useState(false);
  const [routinesShown, showRoutines] = useState(false);
  const [plannerShown, showPlanner] = useState(false);
  const routinesOpen = routinesShown || params.get("view") === "routines";
  const plannerOpen = plannerShown || params.get("view") === "planner";
  const clearBriefTarget = () => {
    const query = new URLSearchParams(params.toString());
    query.delete("view"); query.delete("routine"); query.delete("task");
    router.replace(`/chat?${query.toString()}`);
  };
  const setRoutinesOpen = (open: boolean) => { showRoutines(open); if (!open && params.get("view") === "routines") clearBriefTarget(); };
  const setPlannerOpen = (open: boolean) => { showPlanner(open); if (!open && params.get("view") === "planner") clearBriefTarget(); };
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [todayOpen, setTodayOpen] = useState(false);
  const [todayLoading, setTodayLoading] = useState(false);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [todaySnapshot, setTodaySnapshot] = useState<NeedsYouSnapshot | null>(null);
  // Files chosen for the next message, and why one was refused.
  const [attached, setAttached] = useState<File[]>([]);
  const audioAbort = useRef<AbortController | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [audioConsent, setAudioConsent] = useState(false);
  const [audioCapability, setAudioCapability] = useState<{ provider_label: string; available: boolean; retention: string } | null>(null);
  useEffect(() => { api.audioCapabilities().then(setAudioCapability).catch(() => setAudioCapability(null)); }, []);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  // Skills picked for the next message only, and the text a Save as skill opened the editor with.
  // Both are tied to the agent they were made for, so another agent starts clean.
  const [picked, setPicked] = useState<{ agentId: number | null; names: string[] }>({ agentId: null, names: [] });
  const [skillSeed, setSkillSeed] = useState<{ source: SkillLearnSource; nonce: number } | null>(null);
  const [loadedSkills, setLoadedSkills] = useState<{ agentId: number; list: SkillSummary[] } | null>(null);
  // What "Always allow this command" did, by approval id, and rules undone here.
  const [remembered, setRemembered] = useState<Record<string, Remembered>>({});
  const [undoneRules, setUndoneRules] = useState<number[]>([]);
  // The agent a new chat will start with (null: a plain chat).
  const [newAgentId, setNewAgentId] = useState<number | null>(() => parseThreadId(params.get("agent")));
  const newAgentIdRef = useRef(newAgentId);
  useLayoutEffect(() => { newAgentIdRef.current = newAgentId; }, [newAgentId]);
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const cachedPref = readCachedPreference();
  const [newProvider, setNewProvider] = useState(() => params.get("engine") || cachedPref?.provider || "claude");
  const [newProviderOverride, setNewProviderOverride] = useState<string | null>(() => params.get("engine"));
  const [newModel, setNewModel] = useState<string | null>(() => params.get("model") || (newAgentId === null && params.get("engine") === null ? cachedPref?.model ?? null : null));
  const [newEffort, setNewEffort] = useState<string | null>(() => params.get("effort") || (newAgentId === null && params.get("engine") === null ? cachedPref?.effort ?? null : null));

  const [modelDraft, setModelDraft] = useState<{ threadId: number | null; agentId: number | null; provider: string; model: string | null; effort: string | null } | null>(null);
  // A dropdown selection can reach the submit click before the parent render commits.
  const modelDraftRef = useRef<typeof modelDraft>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Engine discovery also grants access to history and setup when Claude is
  // absent. Starting a turn is checked against the selected engine below.
  const ready = gate.phase === "ready" && (gate.status.available || (gate.status.enabled && engines !== null));
  const stream = useThreadStream(ready ? threadId : null);
  const { transcript } = stream;

  useEffect(() => {
    if (params.get("onboarding") !== "1" || threadId !== null) return;
    let live = true;
    onboarding.get().then(value => {
      if (live) setDraft(previous => previous || value.draft.first_request);
    }).catch(() => {});
    return () => { live = false; };
  }, [params, threadId]);

  useEffect(() => {
    if (threadId === null || transcript.runningTurnId !== null || !transcript.items.some(item => item.kind === "turn_end")) return;
    // The server verifies a successful turn in this owner's thread before recording the milestone.
    void onboarding.firstReply(threadId).catch(() => {});
  }, [threadId, transcript.runningTurnId, transcript.items]);

  useEffect(() => {
    let live = true;
    api.getEnginePreference().then((saved) => {
      if (!live || !saved?.provider) return;
      writeCachedPreference({ provider: saved.provider, model: saved.model, effort: saved.effort });
      if (!params.get("engine") && threadId === null && newAgentIdRef.current === null) {
        setNewProvider(saved.provider);
        if (!params.get("model")) setNewModel(saved.model);
        if (!params.get("effort")) setNewEffort(saved.effort ?? null);
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [threadId, transcript.runningTurnId, transcript.items]);

  useEffect(() => {
    let cancelled = false;
    // The chat opens on the status alone; the engine list (it checks every CLI, so it can take seconds)
    // fills in when it arrives and nothing waits for it.
    api.getEngines().then((items) => {
      if (cancelled) return;
      setEngines(items);
      if (!params.get("engine") && threadId === null && newAgentIdRef.current === null) {
        setNewProvider((current) => {
          const resolved = resolveEngineModel({ provider: current, model: newModel, effort: newEffort }, items);
          if (resolved.model !== newModel && !params.get("model")) {
            setNewModel(resolved.model);
          }
          if (resolved.effort !== newEffort && !params.get("effort")) {
            setNewEffort(resolved.effort ?? null);
          }
          return resolved.provider;
        });
      }
    }).catch(() => { if (!cancelled) setEngines(null); });
    api.getLocalStatus()
      .then((status) => {
        if (cancelled) return;
        setGate({ phase: "ready", status });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isLaunchTokenMissing(err)) return setGate({ phase: "locked" });
        // An answer that is an error (an older backend without the route) is not "unreachable".
        setGate(err instanceof ApiError ? { phase: "ready", status: { enabled: false, available: false, reason: null, cli_version: null } } : { phase: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [statusTick]);

  // Tell the server the person is here (it stores their time zone and writes
  // today's Needs you card). It names the card's chat only on a return or the
  // first visit of the day, and never moves a chat that is already open.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const ping = () => {
      if (document.visibilityState === "hidden") return;
      reportPresence()
        .then((result) => {
          if (!cancelled && result.open && !window.location.search.match(/[?&](thread|room|view|panel)=/)) router.push(`/chat?thread=${result.open.thread_id}`);
        })
        .catch(() => {
          // Not the owner, or an older backend: nothing to show.
        });
    };
    ping();
    document.addEventListener("visibilitychange", ping);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", ping);
    };
  }, [ready, router]);

  const checkAgain = () => {
    setGate({ phase: "loading" });
    setStatusTick((n) => n + 1);
  };

  // The list is read whenever the tick changes, and again when a turn starts or
  // ends (that changes the order, the title and the session state).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api
      .listThreads(showArchived)
      .then((list) => !cancelled && setThreads(list))
      .catch(() => {
        // keep what is shown; the next refresh tries again
      });
    return () => {
      cancelled = true;
    };
  }, [ready, listTick, showArchived, transcript.runningTurnId]);

  // A bookmarked archived conversation may be absent from the sidebar. Its
  // engine and model still come from the conversation, never new-chat defaults.
  useEffect(() => {
    if (!ready || threadId === null) return;
    let cancelled = false;
    api.getThread(threadId).then((value) => { if (!cancelled) setOpenedThread(value); }).catch((error: unknown) => {
      // A deleted conversation can remain in local state until the next list
      // poll. Clear its cached agent/computer metadata on a definite 404.
      if (!cancelled && error instanceof ApiError && error.status === 404) {
        setOpenedThread((current) => current?.id === threadId ? null : current);
        setThreads((current) => current?.filter((item) => item.id !== threadId) ?? current);
      }
    });
    return () => { cancelled = true; };
  }, [ready, threadId, listTick, transcript.runningTurnId]);

  useEffect(() => {
    const closeModel = () => setModelDraft(null);
    window.addEventListener("popstate", closeModel);
    return () => window.removeEventListener("popstate", closeModel);
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    api
      .listAgents(true)
      .then((list) => !cancelled && setAgents(list))
      .catch((err: unknown) => {
        // 404: an older backend without agents. Anything else: keep what is shown.
        if (!cancelled && err instanceof ApiError && err.status === 404) setAgents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, agentTick, transcript.runningTurnId]);

  useEffect(() => {
    if (!ready || agents === null || agents.length > 0 || firstAgentRedirecting.current) return;
    let cancelled = false;
    onboarding.get().then((progress) => {
      if (!cancelled && progress.status === "pending" && !progress.existing_agents) {
        firstAgentRedirecting.current = true;
        router.replace("/onboarding/");
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agents, ready, router]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    collaboration.team().then(value => { if (live) setTeamState(value); }).catch(() => {});
    return () => { live = false; };
  }, [ready, agentTick, transcript.runningTurnId]);

  useEffect(() => {
    const openAgent = (event: Event) => {
      const detail = (event as CustomEvent<{ id: number; edit: boolean }>).detail;
      if (detail.edit) {
        const target = agents?.find(agent => agent.id === detail.id);
        if (target) { setEditAgent(target); setAgentsCreate(false); setAgentsOpen(true); }
      } else {
        setNewAgentId(detail.id); setNewModel(null); router.push(`/chat?agent=${detail.id}`); setFocusComposer(true);
      }
    };
    window.addEventListener("open-dots:open-agent", openAgent);
    return () => window.removeEventListener("open-dots:open-agent", openAgent);
  }, [agents, router, setAgentsOpen]);

  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setListTick((n) => n + 1);
    }, LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [ready]);

  const thread = (openedThread?.id === threadId ? openedThread : null) ?? threads?.find((t) => t.id === threadId) ?? null;
  const threadAgent = thread?.agent_id != null ? (agents?.find((a) => a.id === thread.agent_id) ?? null) : null;
  // The computer this conversation's tools run in; older backends send none.
  const threadComputer = thread?.computer ?? threadAgent?.computer ?? null;
  const [liveComputer, setLiveComputer] = useState<{ id: number; state: string } | null>(null);
  const liveComputerState = liveComputer && liveComputer.id === threadComputer?.id ? liveComputer.state : null;

  useEffect(() => {
    if (!ready || !threadAgent || !threadComputer) return;
    let cancelled = false;
    const refreshComputer = async () => {
      try {
        const computer = await api.getAgentComputer(threadAgent.id);
        if (!cancelled) setLiveComputer({ id: computer.id, state: computer.live_state ?? computer.state });
      } catch {
        if (!cancelled) setLiveComputer(null);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshComputer();
    };
    void refreshComputer();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = setInterval(() => {
      refreshWhenVisible();
    }, COMPUTER_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [ready, threadAgent?.id, threadComputer?.id]);

  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences | null>(null);
  const liveTurnStarted = useRef(false);
  const lastRunningTurnId = useRef<number | null>(null);
  const alertedApprovalIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    api.getNotificationPreferences().then((loaded) => {
      if (alive) setNotificationPrefs(loaded);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // A different conversation starts with no turn in flight; never carry
    // the previous thread's turn state into it.
    liveTurnStarted.current = false;
    lastRunningTurnId.current = null;
  }, [threadId]);

  useEffect(() => {
    if (stream.connection === "live" && transcript.runningTurnId !== null && lastRunningTurnId.current === null) {
      liveTurnStarted.current = true;
    }
  }, [stream.connection, transcript.runningTurnId]);

  useEffect(() => {
    if (transcript.runningTurnId !== null) {
      lastRunningTurnId.current = transcript.runningTurnId;
    }
  }, [transcript.runningTurnId]);

  useEffect(() => {
    const finishedTurnId = lastRunningTurnId.current;
    if (transcript.runningTurnId === null && finishedTurnId !== null && liveTurnStarted.current) {
      liveTurnStarted.current = false;
      lastRunningTurnId.current = null;

      if (notificationPrefs && notificationPrefs.desktop_enabled) {
        const turnEndItem = transcript.items.find(
          (item) => item.kind === "turn_end" && item.turnId === finishedTurnId
        );
        const status = (turnEndItem as { status?: string })?.status ?? "completed";
        const error = (turnEndItem as { error?: string })?.error ?? null;

        const assistantItem = [...transcript.items]
          .reverse()
          .find((item) => item.kind === "assistant" && item.turnId === finishedTurnId);
        const textContent = (assistantItem as { text?: string })?.text ?? null;

        const agentName = threadAgent?.name || "Open Duet";

        notifyTurnCompletion({
          agentName,
          text: textContent,
          status,
          error,
          threadId,
          prefs: notificationPrefs,
          onOpenThread: (tid) => router.push(`/chat?thread=${tid}`),
        });
      }
    }
  }, [transcript.runningTurnId, transcript.items, notificationPrefs, threadAgent, threadId, router]);

  useEffect(() => {
    if (!liveTurnStarted.current || !notificationPrefs || !notificationPrefs.desktop_enabled) return;

    for (const item of transcript.items) {
      if (item.kind === "approval" && item.status === "pending") {
        if (!alertedApprovalIds.current.has(item.approvalId)) {
          alertedApprovalIds.current.add(item.approvalId);
          const agentName = threadAgent?.name || "Open Duet";
          notifyApprovalNeeded({
            agentName,
            summary: item.summary,
            tool: item.tool,
            threadId,
            approvalId: item.approvalId,
            prefs: notificationPrefs,
            onOpenThread: (tid) => router.push(`/chat?thread=${tid}`),
          });
        }
      }
    }
  }, [transcript.items, notificationPrefs, threadAgent, threadId, router]);

  const { updateAvailable, latestVersion, dismissed: updateDismissed, dismiss: dismissUpdateNotice } = useVersionUpdate();

  const choosable = activeAgents(agents);
  // The chosen agent may have been archived since: then the chat starts plain.
  const startingAgentId = choosable.some((a) => a.id === newAgentId) ? newAgentId : null;
  const startingAgent = choosable.find((agent) => agent.id === startingAgentId);
  const selectedProvider = thread?.provider ?? (startingAgent ? newProviderOverride ?? startingAgent.provider : newProviderOverride ?? newProvider);
  const selectedEngine = engines?.find((engine) => engine.id === selectedProvider);
  const selectedAgent = threadId === null
    ? (startingAgent?.provider === selectedProvider ? startingAgent : null)
    : (threadAgent?.provider === thread?.provider ? threadAgent : null);
  const selectedModel = (threadId === null ? newModel : thread?.model) ?? selectedAgent?.model ?? null;
  const selectedEffort = (threadId === null ? newEffort : thread?.effort) ?? null;
  const skillAgent = threadId === null ? startingAgent : threadAgent;
  const skillAgentId = skillAgent?.id ?? null;
  const [skillsTick, setSkillsTick] = useState(0);
  useEffect(() => {
    if (!ready || skillAgentId === null) return;
    let live = true;
    api.listSkills(skillAgentId).then(
      (list) => live && setLoadedSkills({ agentId: skillAgentId, list }),
      () => live && setLoadedSkills({ agentId: skillAgentId, list: [] }),
    );
    return () => { live = false; };
  }, [ready, skillAgentId, skillsTick]);
  const agentSkills = loadedSkills !== null && loadedSkills.agentId === skillAgentId ? loadedSkills.list : [];
  const chosenSkills = picked.agentId === skillAgentId ? picked.names.filter((n) => agentSkills.some((s) => s.name === n && s.enabled)) : [];
  const setChosenSkills = (update: (names: string[]) => string[]) =>
    setPicked({ agentId: skillAgentId, names: update(chosenSkills) });
  const skillTurnId = learnableTurn(transcript.items);
  const canSaveSkill = threadAgent !== null && threadId !== null && skillTurnId !== null && transcript.runningTurnId === null;
  const waiting = pendingApprovals(transcript).length > 0;
  const canMessageDuringRun = stream.threadId === threadId && transcript.runningTurnId !== null && threadId !== null && thread?.kind === "chat" && !waiting;
  const workingMode = canMessageDuringRun
    ? selectedEngine?.capabilities.steering ? "steer" as const : "queue" as const
    : null;
  const failedQueuedId = failedQueued?.threadId === threadId ? failedQueued.id : null;
  const queuedTurnPending = queuedTurn?.threadId === threadId &&
    !transcript.items.some((item) => item.kind === "turn_end" && item.turnId === queuedTurn.turnId);

  const writeQueuedFollowUps = (id: number, items: QueuedFollowUp[]) => {
    saveQueuedFollowUps(id, items);
  };

  const enqueueFollowUp = (id: number, text: string): boolean => {
    const current = loadQueuedFollowUps(id);
    if (current.length >= MAX_QUEUED_FOLLOW_UPS) return false;
    writeQueuedFollowUps(id, [...current, newQueuedFollowUp(text)]);
    return true;
  };

  useEffect(() => {
    const first = threadQueuedFollowUps[0];
    if (
      threadId === null || stream.threadId !== threadId || !first || stream.connection !== "live" || transcript.runningTurnId !== null ||
      waiting || sending || queuedSending || queuedTurnPending || failedQueuedId === first.id || queuedDrainRef.current
    ) return;
    queuedDrainRef.current = true;
    setQueuedSending(true);
    liveTurnStarted.current = true;
    void api.sendTurn(threadId, first.text).then((turn) => {
      const current = loadQueuedFollowUps(threadId);
      if (current[0]?.id === first.id) writeQueuedFollowUps(threadId, current.slice(1));
      if (currentThreadIdRef.current === threadId) setQueuedTurn({ threadId, turnId: turn.id });
      if (currentThreadIdRef.current === threadId) {
        setSendError(null);
        setFailedQueued(null);
      }
    }).catch((err) => {
      if (currentThreadIdRef.current === threadId) {
        setSendError(sendErrorText(err));
        setFailedQueued({ threadId, id: first.id });
      }
    }).finally(() => {
      queuedDrainRef.current = false;
      setQueuedSending(false);
    });
  }, [threadId, threadQueuedFollowUps, stream.connection, transcript.runningTurnId, waiting, sending, queuedSending, queuedTurnPending, failedQueuedId]);

  const totals = conversationUsage(
    transcript.items.flatMap((item) => (item.kind === "turn_end" ? [{ usage: item.usage }] : []))
  );
  const conversationTotal =
    totals.turns === 0
      ? "Tokens and cost by month"
      : `This conversation: ${formatTokens(totals.tokens)} tokens, ${formatCost(totals.cost)}` +
        (totals.reported < totals.turns ? ` (${totals.turns - totals.reported} turn(s) reported nothing)` : "");

  let blockedReason: string | null = null;
  if (stream.connection === "failed") blockedReason = "This conversation cannot be opened.";
  else if (threadId !== null && thread === null) blockedReason = "Loading conversation…";
  else if (thread?.session_state === "broken")
    blockedReason = "Start a new session to continue this conversation.";
  else if (waiting) blockedReason = "The engine is waiting for your answer above.";
  else if (transcript.runningTurnId !== null && !canMessageDuringRun) blockedReason = "An answer is running…";
  else if (selectedEngine && !selectedEngine.available && !canMessageDuringRun) blockedReason = selectedEngine.reason ?? "This engine is unavailable. Check its settings.";

  // A signed-out engine gets a button to its sign-in; there may be no terminal to use.
  const signInAction = selectedEngine && !selectedEngine.available && selectedEngine.signed_in === false
    ? { label: `Sign in to ${selectedEngine.label}`, onClick: () => router.push("/settings/engines/") }
    : undefined;

  const imagesAttached = attached.some((file) => file.type.startsWith("image/"));
  const imagesRefused = imagesAttached && selectedEngine !== undefined && !selectedEngine.capabilities.images;
  if (blockedReason === null && imagesRefused)
    blockedReason = `${selectedEngine?.label ?? "This engine"} can't read images. Remove the image to send.`;

  const hasAudio = !!audioUrl.trim() || attached.some((file) => /\.(wav|mp3|m4a|ogg|flac|webm)$/i.test(file.name));
  if (blockedReason === null && hasAudio && (!audioCapability?.available || !audioConsent)) blockedReason = !audioCapability?.available ? t("chat.audioUnavailable") : t("chat.audioConsentRequired", { provider: audioCapability?.provider_label ?? "OpenAI" });

  if (blockedReason === null && audioUrl.trim() && attached.length >= MAX_ATTACHMENTS) blockedReason = `Attach at most ${MAX_ATTACHMENTS} files or audio links to one message.`;
  if (blockedReason === null && canMessageDuringRun && (attached.length > 0 || audioUrl.trim()))
    blockedReason = "Remove attachments and audio links to send a text follow-up while this answer is running.";

  const sendingReactionReplyDisabled = threadId === null || !ready || stream.connection === "failed" || thread === null ||
    thread.session_state === "broken" || waiting || transcript.runningTurnId !== null ||
    (selectedEngine !== undefined && !selectedEngine.available);

  const addFiles = (files: File[]) => {
    const problems: string[] = [];
    const accepted = files.filter((file) => {
      const problem = attachmentProblem(file);
      if (problem) problems.push(problem);
      return problem === null;
    });
    const room = Math.max(0, MAX_ATTACHMENTS - attached.length);
    if (accepted.length > room) problems.push(`Attach at most ${MAX_ATTACHMENTS} files to one message.`);
    setAttached((previous) => [...previous, ...accepted.slice(0, room)]);
    setAttachNotice(problems.length ? problems.join(" ") : null);
  };

  const send = async () => {
    if (transcript.runningTurnId !== null) {
      if (!canMessageDuringRun || threadId === null) return;
      const text = draft.trim();
      if (!text) return;
      if (text.length > MAX_FOLLOW_UP_TEXT_CHARS) {
        setSendError(t("composer.messageTooLong"));
        return;
      }
      if (attached.length > 0 || audioUrl.trim()) {
        setSendError("Remove attachments and audio links before sending a message during a running answer.");
        return;
      }
      setSendError(null);
      setSending(true);
      try {
        let queued = workingMode === "queue";
        if (!queued) {
          try {
            await api.steerThread(threadId, text);
          } catch (err) {
            if (err instanceof ApiError && ["steer_unsupported", "turn_not_steerable", "steer_rejected", "no_running_turn"].includes(err.code ?? "")) {
              queued = true;
            } else {
              throw err;
            }
          }
        }
        if (queued && !enqueueFollowUp(threadId, text)) {
          setSendError(t("composer.queueFull"));
          return;
        }
        setDraft("");
        setChosenSkills(() => []);
        setAttachNotice(null);
      } catch (err) {
        setSendError(sendErrorText(err));
      } finally {
        setSending(false);
        setListTick((n) => n + 1);
      }
      return;
    }

    // `/name rest` for a skill that is on selects it; anything else is sent as typed.
    const command = parseSkillCommand(draft, agentSkills.filter((s) => s.enabled).map((s) => s.name));
    const usedSkills = command ? toggleSkillOn(chosenSkills, command.name) : chosenSkills;
    const message = command ? command.rest : draft.trim();
    const text = message;
    if (!text) return;
    setSendError(null);
    setSending(true);
    const processing = new AbortController();
    audioAbort.current = processing;
    try {
      let id = threadId;
      if (id === null) {
        id = (await api.createThread(startingAgentId, { provider: selectedProvider, model: newModel, effort: newEffort })).id;
        if (startingAgentId === null) {
          writeCachedPreference({ provider: selectedProvider, model: newModel, effort: newEffort });
          void api.setEnginePreference({ provider: selectedProvider, model: newModel, effort: newEffort }).catch(() => {});
        }
        // Open it now: the stream replays from the start, so nothing is missed.
        router.replace(`/chat?thread=${id}`);
      }
      const ids: string[] = [];
      for (const file of attached) ids.push((await api.uploadAttachment(id, file, audioConsent ? "openai" : undefined, processing.signal)).id);
      if (audioUrl.trim()) ids.push((await api.importAudioUrl(id, audioUrl.trim(), audioConsent ? "openai" : "", processing.signal)).id);
      processing.signal.throwIfAborted();
      liveTurnStarted.current = true;
      await api.sendTurn(id, message, ids, usedSkills);
      setDraft("");
      setChosenSkills(() => []);
      setAttached([]);
      setAudioUrl("");
      setAudioConsent(false);
      setAttachNotice(null);
    } catch (err) {
      setSendError(sendErrorText(err));
      if (err instanceof ApiError && err.code === "skill_unavailable") setSkillsTick((n) => n + 1);
    } finally {
      audioAbort.current = null;
      setSending(false);
      setListTick((n) => n + 1);
    }
  };

  const sendReactionReply = async (message: string): Promise<boolean> => {
    if (sendingReactionReplyDisabled || sending) return false;
    setSendError(null);
    setSending(true);
    try {
      liveTurnStarted.current = true;
      await api.sendTurn(threadId!, message);
      return true;
    } catch (err) {
      setSendError(sendErrorText(err));
      return false;
    } finally {
      setSending(false);
      setListTick((n) => n + 1);
    }
  };

  const saveModel = async () => {
    if (!modelDraft) return;
    const target = modelDraftRef.current ?? modelDraft;
    setModelBusy(true); setModelError(null);
    const model = target.model?.trim() || null;
    const effort = target.effort?.trim() || null;
    try {
      if (target.threadId !== null) {
        const updated = await api.updateThread(target.threadId, { model, effort });
        setThreads((previous) => previous?.map((item) => item.id === target.threadId ? updated : item) ?? null);
        setOpenedThread((previous) => previous?.id === target.threadId ? updated : previous);
      } else {
        setNewModel(model);
        setNewEffort(effort);
        if (target.agentId !== null) {
          setNewProviderOverride(target.provider === startingAgent?.provider ? null : target.provider);
        } else {
          setNewProvider(target.provider);
          setNewProviderOverride(null);
          writeCachedPreference({ provider: target.provider, model, effort });
          void api.setEnginePreference({ provider: target.provider, model, effort }).catch(() => {});
        }
      }
      modelDraftRef.current = null;
      setModelDraft((previous) => previous === target ? null : previous);
    } catch (err) { setModelError(err instanceof ApiError ? err.message : "Could not change the model."); }
    finally { setModelBusy(false); }
  };

  const stop = async () => {
    if (threadId === null || transcript.runningTurnId === null) return;
    setSendError(null);
    setStoppingTurn(transcript.runningTurnId);
    try {
      await api.stopThread(threadId);
    } catch (err) {
      // Already over: the stream says so, nothing to show.
      if (!(err instanceof ApiError && err.code === "no_running_turn")) {
        setSendError(err instanceof ApiError ? err.message : "Could not stop the answer.");
      }
      setStoppingTurn(null);
    }
  };

  // One place for rename, archive and delete: say what went wrong, and always
  // read the list again afterwards.
  const manage = async (change: () => Promise<void>) => {
    setManageError(null);
    try {
      await change();
    } catch (err) {
      setManageError(manageErrorText(err));
    } finally {
      setListTick((n) => n + 1);
    }
  };

  const listActions = {
    onRename: (id: number, title: string) => manage(() => api.updateThread(id, { title }).then(() => {})),
    onArchive: (id: number, archived: boolean) =>
      manage(() => api.updateThread(id, { archived }).then(() => {})),
    onDelete: (id: number) =>
      manage(async () => {
        await api.deleteThread(id);
        if (id === threadId) router.replace("/chat");
      }),
  };

  const answer = async (approvalId: string, decision: "allow" | "deny", remember = false) => {
    if (threadId === null) return;
    setAnswering(approvalId);
    setApprovalErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== approvalId)));
    try {
      const result = await api.answerThreadApproval(threadId, approvalId, decision, remember);
      if (remember && decision === "allow") {
        setRemembered((prev) => ({
          ...prev,
          [approvalId]: { ruleId: result?.rule_id ?? null, error: result?.remember_error ?? null },
        }));
      }
    } catch (err) {
      // Not waiting any more (answered elsewhere, expired, the run ended): the
      // stream already says so, and the card updates by itself.
      if (!(err instanceof ApiError && err.code === "approval_not_waiting")) {
        const message = err instanceof ApiError ? err.message : "Could not send your answer.";
        setApprovalErrors((prev) => ({ ...prev, [approvalId]: message }));
      }
    } finally {
      setAnswering(null);
    }
  };

  // Take back an "always allow": the rule is removed and logged as undone.
  const undoRule = async (ruleId: number) => {
    try {
      await api.deleteApprovalRule(ruleId, threadId);
    } catch (err) {
      // 404: already removed (from the rules list, say). Anything else is shown.
      if (!(err instanceof ApiError && err.status === 404)) {
        setManageError(err instanceof ApiError ? err.message : "Could not remove the rule.");
        return;
      }
    }
    setUndoneRules((prev) => [...prev, ruleId]);
  };

  const resetSession = async () => {
    if (threadId === null) return;
    setResetError(null);
    setResetting(true);
    try {
      await api.resetThreadSession(threadId);
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : "Could not start a new session.");
    } finally {
      setResetting(false);
      setListTick((n) => n + 1);
    }
  };

  const openModelDialog = () => {
    setModelError(null);
    const activeModelId = (threadId === null ? newModel : thread?.model) ?? null;
    const activeEffort = (threadId === null ? newEffort : thread?.effort) ?? null;
    const draft = {
      threadId,
      agentId: startingAgentId,
      provider: selectedProvider,
      model: activeModelId,
      effort: activeEffort,
    };
    modelDraftRef.current = draft;
    setModelDraft(draft);
  };

  const refreshToday = async () => {
    setTodayOpen(true);
    setTodayLoading(true);
    setTodayError(null);
    setTodaySnapshot(null);
    try {
      setTodaySnapshot(await api.getNeedsYou());
    } catch {
      setTodayError(t("chat.refreshTodayError"));
    } finally {
      setTodayLoading(false);
    }
  };

  const todayItem: NeedsYouItem | null = todaySnapshot ? {
    kind: "needs_you",
    key: todaySnapshot.card_id,
    turnId: null,
    cardId: todaySnapshot.card_id,
    revision: 0,
    title: todaySnapshot.title,
    subtitle: todaySnapshot.subtitle,
    emptyText: todaySnapshot.empty_text,
    more: todaySnapshot.more,
    checkedAt: todaySnapshot.checked_at,
    providerCheckedAt: todaySnapshot.provider_checked_at ?? undefined,
    timeZone: todaySnapshot.time_zone,
    sources: todaySnapshot.sources,
    rows: todaySnapshot.items,
  } : null;

  const computerText = threadComputer ? computerChip(threadComputer, liveComputerState) : null;
  const buildHeader = (withSidebar: boolean) => (
    <ChatHeader
      title={roomId !== null
        ? (roomTitle?.id === roomId ? roomTitle.name : t(roomId === "new" ? "room.new" : "room.title"))
        : thread?.title || (threadId === null ? t("shell.newChat") : "Chat")}
      agent={threadAgent ? { id: threadAgent.id, name: threadAgent.name } : null}
      onOpenSidebar={withSidebar && !sidebarInline ? () => setDrawerOpen(true) : undefined}
      agentChoice={
        roomId === null && agents !== null && threadId === null
          ? { agents: choosable, value: startingAgentId, onChange: (id) => { setNewAgentId(id); setNewProviderOverride(null); setNewModel(null); setNewEffort(null); setModelDraft(null); } }
          : undefined
      }
      engine={
        roomId === null && ready && engines && (threadId === null || thread !== null)
          ? {
              label: (() => {
                const baseEngine = selectedEngine?.label ?? selectedProvider;
                const modelObj = selectedEngine?.models.find((item) => item.id === selectedModel);
                const modelName = modelObj?.label ?? (selectedModel ? modelLabel(selectedModel) : "default");
                const supportsEffort = Boolean(
                  modelObj?.supported_reasoning_efforts &&
                  modelObj.supported_reasoning_efforts.length > 1 &&
                  modelObj.reasoning_effort_configurable !== false
                );
                const effortToShow = supportsEffort
                  ? (selectedEffort ?? modelObj?.default_reasoning_effort)
                  : null;
                const effortPart = effortToShow
                  ? ` · ${effortToShow.charAt(0).toUpperCase() + effortToShow.slice(1)}`
                  : "";
                return `${baseEngine} · ${modelName}${effortPart}`;
              })(),
              disabled: modelBusy || sending || transcript.runningTurnId !== null,
              onClick: openModelDialog,
            }
          : undefined
      }
      computer={
        threadComputer && threadAgent && computerText
          ? {
              text: computerText,
              hint: `This conversation's commands and file edits run in ${threadAgent.name}'s computer (${threadComputer.image}), not on this machine.`,
              onClick: () => setPanel("computer"),
            }
          : undefined
      }
      approvalMode={
        ready && gate.phase === "ready" && (gate.status.tools_enabled || threadComputer) && threadId !== null
          ? {
              label: approvalModeLabel(threadAgent?.approval_mode ?? "ask"),
              hint: "How much the engine may do before it asks. Set by the conversation's agent; a plain chat asks first.",
            }
          : undefined
      }
      onApprovals={ready ? () => setApprovalsOpen(true) : undefined}
      onFiles={ready && threadId !== null && thread !== null ? () => setFilesOpen(true) : undefined}
      onUsage={ready ? () => setPanel("usage") : undefined}
      onToday={ready ? () => void refreshToday() : undefined}
      usageHint={conversationTotal}
      trailing={
        <>
          <LanguageSelect compact />
          {ready ? (
            <NotificationBell
              elevated={routinesOpen || panel === "usage"}
              onOpen={() => {
                setRoutinesOpen(false);
                if (panel === "usage") setPanel(null);
              }}
            />
          ) : null}
        </>
      }
      status={
        roomId !== null ? null : stream.connection === "reconnecting"
          ? { text: t("header.reconnecting"), warn: true }
          : ready && selectedEngine
            ? { text: `${selectedEngine.available ? selectedEngine.version ?? t("header.ready") : t("header.unavailable")}${selectedEngine.capabilities.tools ? "" : ` · ${t("header.chatOnly")}`}` }
            : null
      }
    />
  );
  const header = buildHeader(false);

  // Start a conversation: with the given agent, or (no argument) with whatever is chosen now.
  const startChat = (agentId?: number) => {
    if (agentId !== undefined) { setNewAgentId(agentId); setNewModel(null); }
    setModelDraft(null);
    setFocusComposer(true);
    router.push("/chat");
  };

  const sidebar = (
    <Sidebar
      agents={agents}
      threads={threads}
      selectedThreadId={threadId}
      selectedAgentId={roomId !== null ? null : thread?.agent_id ?? (threadId === null ? startingAgentId : null)}
      live={{ threadId, agentId: thread?.agent_id ?? null, working: transcript.runningTurnId !== null, waiting }}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((on) => !on)}
      actions={listActions}
      error={manageError}
      onNewChat={startChat}
      onManageAgents={agents !== null ? () => { setEditAgent(null); setAgentsCreate(false); setAgentsOpen(true); } : undefined}
      leadAgentId={teamState?.team?.lead_agent_id ?? null}
      onChangeLead={session?.scopes.includes("admin") ? async (agent, remove) => {
        try { setTeamState(await (remove ? collaboration.clearLead(agent.id) : collaboration.lead(agent.id))); setAgentTick(value => value + 1); }
        catch (err) { setManageError(err instanceof ApiError ? err.message : "Could not change the lead."); }
      } : undefined}
      onEditAgent={session?.scopes.includes("admin") ? agent => { setEditAgent(agent); setAgentsCreate(false); setAgentsOpen(true); } : undefined}
      onDeleteAgent={agents !== null ? (agent) => { setAgentsCreate(false); setDeleteAgentTarget(agent); setAgentsOpen(true); } : undefined}
      onNewAgent={agents !== null ? () => { setEditAgent(null); setAgentsCreate(true); setAgentsOpen(true); } : undefined}
      collaboration={ready ? <RoomList selected={roomId} onTeam={() => setTeamOpen(true)} onNavigate={() => setDrawerOpen(false)} /> : undefined}
      onOpenRoutines={ready && agents !== null ? () => setRoutinesOpen(true) : undefined}
      onOpenPlanner={ready && agents !== null ? () => setPlannerOpen(true) : undefined}
      onNavigate={() => { setDrawerOpen(false); setModelDraft(null); }}
    />
  );

  if (gate.phase === "loading") {
    return (
      <div className="flex h-dvh flex-col">
        {header}
        <p className="p-6 text-center text-sm text-muted">Loading…</p>
      </div>
    );
  }

  if (gate.phase === "locked") {
    return (
      <div className="flex h-dvh flex-col">
        {header}
        <Notice title="Open this from the Open Duet app">
          This address only works inside the Open Duet window, which keeps your conversations
          private to it. Use that window instead of a browser tab.
        </Notice>
      </div>
    );
  }

  if (gate.phase === "unreachable") {
    return (
      <div className="flex h-dvh flex-col">
        {header}
        <Notice title="Backend not reachable">
          Check that it is running, and that this page&apos;s address (
          {typeof window === "undefined" ? "" : window.location.origin}) is listed in
          FRONTEND_ORIGINS in backend/.env.
        </Notice>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-dvh flex-col">
        {header}
        <Notice
          title={gate.status.enabled ? "Engines are not available" : "Local execution is turned off"}
          action={gate.status.enabled ? { label: "Check again", onClick: checkAgain } : undefined}
        >
          {gate.status.enabled
            ? (gate.status.reason ?? "unknown reason")
            : "Set LOCAL_EXECUTION_ENABLED=true in backend/.env on the machine running the backend, then restart it."}
          <p className="mt-3"><Link href="/settings/engines/" className="underline">Open engine settings</Link> to configure an engine and check its status.</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="relative flex h-dvh">
      <a
        href="#conversation"
        className="sr-only z-50 rounded-field bg-raised px-3 py-2 text-sm font-medium text-ink shadow-lg focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        {t("shell.skip")}
      </a>
      {ready && <CommandPalette agents={agents} threads={threads} onNewChat={startChat} />}
      {sidebarInline ? (
        <aside className="w-72 shrink-0 border-r border-line">{sidebar}</aside>
      ) : (
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} label={t("shell.conversations")}>{sidebar}</Drawer>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
      {buildHeader(true)}
      {updateAvailable && !updateDismissed && (
        <aside aria-label="Update available" className="flex justify-center px-4 py-2.5">
          <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-2.5 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs text-ink shadow-xs">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-accent">Update available:</span>
              <span>Open Duet {latestVersion} is available.</span>
            </div>
            <span className="hidden text-muted/60 sm:inline" aria-hidden="true">•</span>
            <Link
              href="/settings/#setting-general-updates"
              className="font-medium text-accent hover:underline"
            >
              View in Settings
            </Link>
            <button
              type="button"
              onClick={dismissUpdateNotice}
              className="ml-0.5 rounded p-0.5 text-muted transition-colors hover:text-ink cursor-pointer"
              aria-label="Dismiss update notice"
            >
              <X size={14} />
            </button>
          </div>
        </aside>
      )}
      {modelDraft && modelDraft.threadId === threadId && (threadId !== null || modelDraft.agentId === startingAgentId) && engines && (
        <Dialog open onOpenChange={(open) => { if (!open) { modelDraftRef.current = null; setModelDraft(null); } }} title="Engine and model" size="sm">
          <form onSubmit={(event) => { event.preventDefault(); void saveModel(); }} className="space-y-4">
            <EngineModelFields
              engines={engines}
              provider={modelDraft.provider}
              model={modelDraft.model}
              effort={modelDraft.effort}
              onChange={(provider, model, effort) => {
                const current = modelDraftRef.current ?? modelDraft;
                if (!current) return;
                const next = { ...current, provider, model, effort: effort ?? null };
                modelDraftRef.current = next;
                setModelDraft(next);
              }}
              disabled={modelBusy}
              lockProvider={threadId !== null}
              hasComputer={startingAgent?.computer != null}
              defaultLabel={selectedAgent ? `Agent default (${modelLabel(selectedAgent.model)})` : undefined}
            />
            {threadId !== null && <p className="text-xs text-muted">The model changes on the next message. This conversation keeps its engine.</p>}
            {modelError && <p role="alert" className="text-sm text-danger">{modelError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={modelBusy}>{modelBusy ? "Saving…" : "Use model"}</Button>
              <Button disabled={modelBusy} onClick={() => { modelDraftRef.current = null; setModelDraft(null); }}>Cancel</Button>
              <Button variant="ghost" disabled={modelBusy} onClick={() => { setModelBusy(true); api.getEngines(true).then(setEngines).catch(() => setModelError("Could not refresh engines.")).finally(() => setModelBusy(false)); }}>Refresh status</Button>
            </div>
          </form>
        </Dialog>
      )}
      {filesOpen && threadId !== null && (
        <FilesPanel threadId={threadId} workspace={thread?.workspace_path ?? null} onClose={() => setFilesOpen(false)} />
      )}
      {approvalsOpen && (
        <ApprovalsPanel
          threadId={threadId}
          workspace={thread?.workspace_path ?? null}
          onClose={() => setApprovalsOpen(false)}
        />
      )}
      {teamOpen && agents !== null && <TeamPanel agents={agents} onClose={() => setTeamOpen(false)} onChanged={() => setAgentTick(value => value + 1)} />}
      {routinesOpen && agents !== null && (
        <RoutinesPanel key={params.get("routine")} routineId={parseThreadId(params.get("routine"))} agents={agents} onClose={() => setRoutinesOpen(false)} />
      )}
      {plannerOpen && agents !== null && <PlannerPanel key={params.get("task")} taskId={parseThreadId(params.get("task"))} agents={agents} threads={threads ?? []} onClose={() => setPlannerOpen(false)} onOpenRoutines={() => { setPlannerOpen(false); setRoutinesOpen(true); }} />}
      {agentsOpen && agents !== null && (
        <AgentsPanel
          agents={agents}
          startCreating={agentsCreate}
          initialEditAgent={editAgent}
          onSetupChat={id => {
            setAgentTick(value => value + 1);
            setAgentsOpen(false); setEditAgent(null); setDeleteAgentTarget(null);
            const target = threads?.find(item => item.agent_id === id && !item.archived_at && item.session_state !== "broken");
            setNewAgentId(id); setNewModel(null); setDraft(t("agentTeam.setupStarter")); setFocusComposer(true);
            router.push(target ? `/chat?thread=${target.id}` : `/chat?agent=${id}`);
          }}
          initialDeleteAgent={deleteAgentTarget}
          onClose={() => { setAgentsOpen(false); setEditAgent(null); setDeleteAgentTarget(null); }}
          onChanged={() => { setAgentTick((n) => n + 1); setDeleteAgentTarget(null); }}
          onCreated={(agent) => setNewAgentId(agent.id)}
        />
      )}
        <main id="conversation" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
          {/* Active rooms share the chat workspace; RoomView keeps only create/edit in a dialog. */}
          {roomId !== null && agents !== null && (
            <RoomView
              key={roomId}
              roomId={roomId}
              agents={agents}
              onClose={() => router.push("/chat")}
              onSelect={id => router.replace(roomHref(id))}
              onTitleChange={updateRoomTitle}
            />
          )}
          {(roomId === null || agents === null) && <>
          {stream.connection === "failed" ? (
            <Notice title="Cannot open this conversation">{stream.error}</Notice>
          ) : (
            <Conversation
              threadId={threadId}
              loading={threadId !== null && thread === null}
              agent={threadAgent ? { id: threadAgent.id, name: threadAgent.name } : startingAgent ? { id: startingAgent.id, name: startingAgent.name } : null}
              emptyAction={signInAction}
              emptyHint={
                selectedEngine && !selectedEngine.available
                  ? `${selectedEngine.label} is not ready: ${(selectedEngine.reason ?? "check it in Settings").replace(/\.+$/, "")}.`
                  : undefined
              }
              transcript={transcript}
              answering={answering}
              approvalErrors={approvalErrors}
              onAnswer={answer}
              onReactionReply={sendReactionReply}
              sendingReactionReplyDisabled={sendingReactionReplyDisabled || sending}
              remembered={remembered}
              undoneRules={undoneRules}
              onUndo={undoRule}
            />
          )}

          {thread?.session_state === "broken" && (
            <div className="border-t border-warning/50 bg-warning/10 px-4 py-3 text-sm">
              <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-ink">
                  The engine can no longer find this conversation&apos;s session, so it cannot continue it. A new
                  session keeps the messages above but starts without them as context.
                </p>
                <Button variant="primary" onClick={resetSession} loading={resetting}>
                  {resetting ? t("common.starting") : t("chat.startNewSession")}
                </Button>
              </div>
              {resetError && <p className="mx-auto mt-2 max-w-3xl text-xs text-danger">{resetError}</p>}
            </div>
          )}

          <div className="mx-auto w-full max-w-3xl px-3 text-xs text-muted">
            <details>
              <summary className="cursor-pointer">{t("chat.audioLink")}</summary>
              <p>{t("chat.audioFormats")}</p>
              <input aria-label={t("chat.directAudioUrl")} type="url" value={audioUrl} onChange={(event) => { setAudioUrl(event.target.value); setAudioConsent(false); }} placeholder="https://example.com/episode.mp3" disabled={sending} className="my-2 w-full rounded-field border border-line bg-inset p-2" />
              <p>{audioCapability?.available ? audioCapability.retention : t("chat.audioUnavailable")}</p>
              <label className="my-2 flex gap-2"><input type="checkbox" checked={audioConsent} onChange={(event) => setAudioConsent(event.target.checked)} disabled={sending || !audioCapability?.available} />{t("chat.audioConsent", { provider: audioCapability?.provider_label ?? "OpenAI" })}</label>
              {sending && hasAudio && <button type="button" onClick={() => audioAbort.current?.abort()} className="my-2 underline">{t("chat.cancelAudio")}</button>}
              <p>{t("chat.transcriptCaveat")}</p>
            </details>
          </div>
          {threadId !== null && threadQueuedFollowUps.length > 0 && (
            <div className="mx-auto mb-1 w-full max-w-3xl px-3" aria-live="polite">
              <div className="rounded-field border border-line bg-raised px-3 py-2">
                <p className="text-xs font-medium text-muted">{t("composer.queuedForNext")}</p>
                <ul className="mt-1 space-y-1">
                  {threadQueuedFollowUps.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {failedQueuedId === item.id && (
                          <button
                            type="button"
                            onClick={() => { setSendError(null); setFailedQueued(null); }}
                            className="cursor-pointer text-xs text-accent underline"
                          >
                            {t("composer.retryQueued")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (failedQueuedId === item.id) {
                              setFailedQueued(null);
                              setSendError(null);
                            }
                            writeQueuedFollowUps(threadId, threadQueuedFollowUps.filter((queued) => queued.id !== item.id));
                          }}
                          aria-label={t("composer.removeQueued")}
                          className="cursor-pointer text-muted hover:text-ink"
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <Composer
            draftKey={threadId === null ? "new" : String(threadId)}
            focusRequested={focusComposer}
            onFocused={() => setFocusComposer(false)}
            value={draft}
            onChange={setDraft}
            onSend={send}
            sending={sending || queuedSending}
            blockedReason={blockedReason}
            blockedAction={signInAction}
            error={sendError}
            running={transcript.runningTurnId !== null}
            workingMode={workingMode}
            stopping={stoppingTurn !== null && stoppingTurn === transcript.runningTurnId}
            onStop={stop}
            files={attached}
            onAddFiles={addFiles}
            onRemoveFile={(index) => {
              setAttached((previous) => previous.filter((_, i) => i !== index));
              setAttachNotice(null);
            }}
            attachNotice={attachNotice}
            skills={skillAgentId !== null ? agentSkills : undefined}
            chosenSkills={chosenSkills}
            onToggleSkill={skillAgentId !== null ? (name) => setChosenSkills((names) => toggleSkill(names, name)) : undefined}
            onSaveAsSkill={canSaveSkill ? () => { setSkillSeed({ source: { thread_id: threadId!, turn_id: skillTurnId! }, nonce: Date.now() }); setPanel("skills"); } : undefined}
          />
          </>}
        </main>
      </div>
      {panel === "usage" && (
        <Inspector title="Usage" inline={inspectorInline} onClose={() => setPanel(null)}>
          <UsageView />
        </Inspector>
      )}
      {panel === "skills" && threadAgent && (
        <Inspector title={`Skills · ${threadAgent.name}`} inline={inspectorInline} onClose={() => { setSkillSeed(null); setPanel(null); }}>
          <div className="p-4">
            <SkillsPanel key={`${threadAgent.id}-${skillSeed?.nonce ?? 0}`} agent={threadAgent} learnFrom={skillSeed?.source ?? null} onChanged={() => setSkillsTick((n) => n + 1)} />
          </div>
        </Inspector>
      )}
      {panel === "computer" && threadAgent && (
        <Inspector title={`Computer · ${threadAgent.name}`} inline={inspectorInline} onClose={() => setPanel(null)}>
          <ComputerView
            agent={threadAgent}
            onChanged={() => setAgentTick((n) => n + 1)}
            engineSupportsComputers={engines?.find((engine) => engine.id === threadAgent.provider)?.capabilities.computers}
            engineLabel={engines?.find((engine) => engine.id === threadAgent.provider)?.label ?? threadAgent.provider}
          />
        </Inspector>
      )}
      <Dialog
        open={todayOpen}
        onOpenChange={setTodayOpen}
        title={t("header.today")}
        description={t("header.todayDescription")}
        size="wide"
        footer={(
          <>
            <Button onClick={() => setTodayOpen(false)}>{t("common.close")}</Button>
            <Button variant="primary" icon={<RefreshCw size={16} />} onClick={() => void refreshToday()} loading={todayLoading}>
              {todayLoading ? t("common.refreshing") : t("common.refresh")}
            </Button>
          </>
        )}
      >
        {todayLoading ? <p role="status" className="text-sm text-muted">{t("common.refreshingToday")}</p> : null}
        {todayError ? <p role="alert" className="text-sm text-danger">{todayError}</p> : null}
        {!todayLoading && !todayError && todayItem ? <NeedsYouCard item={todayItem} /> : null}
      </Dialog>
    </div>
  );
}
