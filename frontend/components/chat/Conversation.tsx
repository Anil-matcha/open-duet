"use client";

import { ArrowDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { formatReactionReply, isLatestAssistantMessage, loadThreadReactions, saveThreadReaction, type ReactionKind, type ReactionsMap } from "@/lib/reactions";
import type { Transcript, TranscriptItem } from "@/lib/transcript";
import { announcement, groupToolRuns } from "@/lib/transcript-view";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/lib/use-i18n";
import { workingPhase } from "@/lib/working-status";
import { WorkingStatus } from "./WorkingStatus";
import {
  ApprovalCard,
  AssistantMessage,
  DateDivider,
  SessionReset,
  RecalledChip,
  CompactedMarker,
  EngineSwitched,
  ToolRun,
  ToolStep,
  type Remembered,
  TurnEnd,
  UserMessage,
} from "./items";

import { NeedsYouCard } from "./NeedsYouCard";
import { RoutineChangeCard } from "./RoutineChangeCard";
import { DelegationCard, AgentCreatedCard, TeamNoticeCard, TeamSetupCard } from "./TeamCards";

const STICK_DISTANCE_PX = 80;

function findDateDividerItemKeys(items: readonly { key: string; [k: string]: unknown }[]): Set<string> {
  let lastDateKey: string | null = null;
  const dividerKeys = new Set<string>();
  for (const item of items) {
    const ts = "ts" in item && typeof item.ts === "string" ? item.ts : null;
    if (ts) {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) {
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          dividerKeys.add(item.key);
        }
      }
    }
  }
  return dividerKeys;
}


// Says the few things worth hearing (an approval waiting, a finished answer, a failure) once,
// in a visually hidden polite region. The transcript itself is not live: it would be re-read on
// every tool update.
function Announcer({ items }: { items: Transcript["items"] }) {
  const [text, setText] = useState("");
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    const next = announcement(items);
    if (next && next.key !== spoken.current) {
      // The first look at a conversation is history, not news: remember it without speaking.
      if (spoken.current !== null) setText(next.text);
      spoken.current = next.key;
    } else if (!next && spoken.current === null) {
      spoken.current = "";
    }
  }, [items]);
  return <div role="status" aria-live="polite" className="sr-only">{text}</div>;
}

// The transcript, oldest first. It follows new content only while the person is
// at the bottom: scrolling up to read leaves the view where it is, and a button brings
// them back.
export function Conversation({
  transcript,
  answering,
  approvalErrors,
  onAnswer,
  onReactionReply,
  sendingReactionReplyDisabled,
  remembered = {},
  undoneRules = [],
  onUndo,
  threadId = null,
  workspacePath = null,
  emptyHint,
  emptyAction,
  agent = null,
  loading = false,
}: {
  // The conversation the transcript belongs to: attachments are fetched from it.
  threadId?: number | null;
  // The pinned workspace also scopes download links in assistant replies.
  workspacePath?: string | null;
  // What to say when there is nothing yet (depends on whether an engine is ready).
  emptyHint?: string;
  // Shown under the hint, e.g. a button that opens the engine sign-in.
  emptyAction?: { label: string; onClick: () => void };
  // Who the conversation is with, for the empty state; null for a plain chat.
  agent?: { id: number; name: string } | null;
  // The conversation is still being fetched: show placeholders instead of the empty state.
  loading?: boolean;
  transcript: Transcript;
  answering: string | null;
  approvalErrors: Record<string, string>;
  onAnswer: (approvalId: string, decision: "allow" | "deny", remember?: boolean) => void;
  onReactionReply: (message: string) => Promise<boolean>;
  sendingReactionReplyDisabled: boolean;
  // "Always allow" outcomes by approval id, from answers given on this page.
  remembered?: Record<string, Remembered>;
  undoneRules?: number[];
  onUndo?: (ruleId: number) => void;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [away, setAway] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [transcript.items.length, transcript.typing, transcript.runningTurnId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_DISTANCE_PX;
    setAway((previous) => (previous === !stuck.current ? previous : !stuck.current));
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const [threadReactions, setThreadReactions] = useState<{ id: number | null | undefined; map: ReactionsMap }>(() => ({
    id: threadId,
    map: loadThreadReactions(threadId),
  }));

  const reactions = threadReactions.id === threadId ? threadReactions.map : loadThreadReactions(threadId);

  const handleReact = async (itemKey: string, reaction: ReactionKind) => {
    if (reactions[itemKey] === reaction) {
      const next = saveThreadReaction(threadId, itemKey, null);
      setThreadReactions({ id: threadId, map: next });
      return;
    }
    if (!await onReactionReply(formatReactionReply(reaction))) return;
    const next = saveThreadReaction(threadId, itemKey, reaction);
    setThreadReactions({ id: threadId, map: next });
  };

  const working = transcript.runningTurnId !== null && !transcript.typing;
  const waitingOnYou = transcript.items.some((i) => i.kind === "approval" && i.status === "pending");
  const empty = transcript.items.length === 0 && transcript.typing === null && !loading;
  const showSkeleton = loading && transcript.items.length === 0 && transcript.typing === null;
  const groupedItems = groupToolRuns(transcript.items);
  const dividerKeys = findDateDividerItemKeys(groupedItems);
  return (
    <div className="relative min-h-0 flex-1">
      <Announcer items={transcript.items} />
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto">
        <div role="log" aria-live="off" aria-label={t("chat.conversation")} className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
          {showSkeleton && (
            <div role="status" aria-busy="true" className="flex flex-col gap-5 py-2">
              <span className="sr-only">{t("chat.loading")}</span>
              <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
              <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
            </div>
          )}
          {empty && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Avatar agentId={agent?.id ?? null} name={agent?.name} size="lg" />
              <p className="text-lg font-semibold">{agent ? t("chat.emptyPromptWithAgent", { name: agent.name }) : t("chat.emptyPrompt")}</p>
              {emptyHint && <p className="max-w-md text-sm text-muted">{emptyHint}</p>}
              {emptyAction && <Button variant="primary" onClick={emptyAction.onClick}>{emptyAction.label}</Button>}
              <p className="max-w-md text-xs text-faint">
                {t("chat.historyHint")}
              </p>
            </div>
          )}

          {groupedItems.map((item) => {
            const ts = "ts" in item && typeof item.ts === "string" ? item.ts : null;
            const dateDivider = dividerKeys.has(item.key) && ts ? (
              <DateDivider key={`date-${item.key}`} ts={ts} />
            ) : null;

              let node: React.ReactNode = null;
              switch (item.kind) {
                case "needs_you":
                  node = <NeedsYouCard key={item.key} item={item} />;
                  break;
                case "team_job":
                  node = <DelegationCard key={item.key} item={item} />;
                  break;
                case "team_notice":
                  node = <TeamNoticeCard key={item.key} item={item} />;
                  break;
                case "team_setup":
                  node = <TeamSetupCard key={item.key} item={item} />;
                  break;
                case "routine_change":
                  node = <RoutineChangeCard key={item.key} item={item} />;
                  break;
                case "agent_created":
                  node = <AgentCreatedCard key={item.key} item={item} />;
                  break;
                case "tool_run":
                  node = <ToolRun key={item.key} tools={item.tools as Extract<TranscriptItem, { kind: "tool" }>[]} />;
                  break;
                case "user":
                  node = <UserMessage key={item.key} item={item} threadId={threadId} />;
                  break;
                case "assistant": {
                  const canReplyToMessage = !item.incomplete && isLatestAssistantMessage(item.key, transcript.items);
                  node = (
                    <AssistantMessage
                      key={item.key}
                      text={item.text}
                      threadId={threadId}
                      workspacePath={workspacePath}
                      incomplete={item.incomplete}
                      ts={item.ts}
                      reaction={reactions[item.key] ?? null}
                      onReact={canReplyToMessage ? (r) => { void handleReact(item.key, r); } : undefined}
                      disabled={answering !== null || sendingReactionReplyDisabled}
                    />
                  );
                  break;
                }
                case "tool":
                  node = <ToolStep key={item.key} item={item} />;
                  break;
                case "approval":
                  node = (
                    <ApprovalCard
                      key={item.key}
                      item={item}
                      answering={answering === item.approvalId}
                      error={approvalErrors[item.approvalId] ?? null}
                      onAnswer={(decision, remember) => onAnswer(item.approvalId, decision, remember)}
                      remembered={remembered[item.approvalId]}
                      undoneRules={undoneRules}
                      onUndo={onUndo}
                    />
                  );
                  break;
                case "turn_end":
                  node = <TurnEnd key={item.key} item={item} />;
                  break;
                case "session_reset":
                  node = <SessionReset key={item.key} item={item} />;
                  break;
                case "recalled":
                  node = <RecalledChip key={item.key} item={item} />;
                  break;
                case "compacted":
                  node = <CompactedMarker key={item.key} item={item} />;
                  break;
                case "engine_switched":
                  node = <EngineSwitched key={item.key} item={item} />;
                  break;
              }

              if (dateDivider) {
                return (
                  <Fragment key={item.key}>
                    {dateDivider}
                    {node}
                  </Fragment>
                );
              }
              return node;
            })}

          {transcript.typing !== null && transcript.typing !== "" && <AssistantMessage text={transcript.typing} live />}

          {transcript.runningTurnId !== null && (working || waitingOnYou) && (
            <WorkingStatus key={transcript.runningTurnId} phase={workingPhase(transcript.items)} turnId={transcript.runningTurnId} />
          )}
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={t("chat.jumpLatest")}
          title={t("chat.jumpLatest")}
          className="absolute bottom-3 left-1/2 inline-flex size-9 -translate-x-1/2 cursor-pointer animate-pop-in items-center justify-center rounded-full border border-line bg-raised text-ink shadow-lg hover:bg-hover touch:size-11"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
