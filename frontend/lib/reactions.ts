// Reactions: thumbs up/down feedback and quick replies for messages and approvals.
// Pure functions with no React imports, so Node tests can run without DOM.

export type ReactionKind = "thumbs_up" | "thumbs_down";

export type ReactionsMap = Record<string, ReactionKind>;

export type PendingApprovalRef = {
  kind: "approval";
  approvalId: string;
  status: string;
};

// Format the short turn prompt sent to the agent when a thumbs reaction acts as a reply.
export function formatReactionReply(reaction: ReactionKind): string {
  if (reaction === "thumbs_up") {
    return "👍 Looks good, please proceed.";
  }
  return "👎 No, please stop or revise this approach.";
}

// Check whether an item is the latest completed assistant message in the conversation transcript.
export function isLatestAssistantMessage(
  itemKey: string,
  items: readonly { kind: string; key: string }[]
): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "assistant") {
      return items[i].key === itemKey;
    }
  }
  return false;
}

// Find any pending approval item in the transcript that can be answered by thumbs up/down.
export function findPendingApproval(
  items: readonly { kind: string; status?: string; approvalId?: string }[]
): PendingApprovalRef | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "approval" && item.status === "pending" && typeof item.approvalId === "string") {
      return { kind: "approval", approvalId: item.approvalId, status: item.status };
    }
  }
  return null;
}

export function getReactionsStorageKey(threadId: number | null | undefined): string {
  return `open-duet:reactions:${threadId ?? "global"}`;
}

export function loadThreadReactions(threadId: number | null | undefined): ReactionsMap {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(getReactionsStorageKey(threadId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: ReactionsMap = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (val === "thumbs_up" || val === "thumbs_down") {
          result[key] = val;
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveThreadReaction(
  threadId: number | null | undefined,
  messageKey: string,
  reaction: ReactionKind | null
): ReactionsMap {
  const current = loadThreadReactions(threadId);
  const next: ReactionsMap = { ...current };

  if (reaction === null || next[messageKey] === reaction) {
    delete next[messageKey];
  } else {
    next[messageKey] = reaction;
  }

  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const key = getReactionsStorageKey(threadId);
      if (Object.keys(next).length === 0) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {
      // ignore storage errors
    }
  }

  return next;
}