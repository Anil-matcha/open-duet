// The attention surface's logic, pure: what to announce, at what priority, when
// to coalesce, which items earn a native notification, and how to feature-detect
// a desktop notifier. No React, no DOM, no fetch — the components and hooks are
// thin consumers, so the announce mapping is unit-testable in the repo's
// node:test style.

export type Urgency = "expired" | "due" | "normal";

export type FeedItem = {
  kind: "approval" | "needs_you";
  thread_id: number | null;
  agent_id: number | null;
  agent_name: string | null;
  title: string;
  created_at: string;
  deadline: string | null;
  urgency: Urgency;
};

// Announcements coalesce: several changes inside this window become the single
// most urgent/latest one. Announcement storms are degraded deliberately.
export const COALESCE_MS = 500;

// OS notifications are reserved for items that are actually urgent, so a stream
// of normal items does not become notification fatigue.
export function worthyOfNativeNotification(item: FeedItem): boolean {
  return item.urgency === "expired" || item.urgency === "due";
}

// The live-region politeness for an announcement: assertive when anything is
// expired/due, polite otherwise.
export function livePriority(items: readonly FeedItem[]): "assertive" | "polite" {
  return items.some(worthyOfNativeNotification) ? "assertive" : "polite";
}

const URGENCY_RANK: Record<Urgency, number> = { expired: 0, due: 1, normal: 2 };

// Within a coalescing window, the most urgent item wins; ties broken by newest.
export function mostUrgent(items: readonly FeedItem[]): FeedItem | null {
  let best: FeedItem | null = null;
  for (const item of items) {
    if (best === null) {
      best = item;
      continue;
    }
    const rank = URGENCY_RANK[item.urgency];
    const bestRank = URGENCY_RANK[best.urgency];
    if (rank < bestRank || (rank === bestRank && Date.parse(item.created_at) > Date.parse(best.created_at))) {
      best = item;
    }
  }
  return best;
}

// The stable key of an item, so the same item is never announced or notified
// twice while it stays in the feed.
export function itemKey(item: FeedItem): string {
  const who = item.agent_name ?? (item.thread_id != null ? `thread ${item.thread_id}` : "another agent");
  return `${item.kind}:${item.thread_id ?? "none"}:${who}:${item.title}`;
}

// What the live region should say for one item. Derived from the feed item
// only — no ad-hoc strings invented for non-feed events.
export function announceText(item: FeedItem): string {
  const who = item.agent_name ?? (item.thread_id != null ? `thread ${item.thread_id}` : "another agent");
  const urgent = item.urgency === "expired" ? " (overdue)" : item.urgency === "due" ? " (due soon)" : "";
  if (item.kind === "approval") {
    return `Approval needed in ${who}${urgent}: ${item.title}`;
  }
  return `Needs you in ${who}${urgent}: ${item.title}`;
}

// --- Announce scheduling (pure reducer) --------------------------------------
//
// The hook feeds this with (frame, feed) and it decides when to speak. It holds
// no timers itself: callers pass `now` and a `flush` step, so it is testable
// without a clock.

export type AnnounceState = {
  pending: FeedItem[];
  windowStartedAt: number | null;
  spokenKeys: Set<string>;
};

export function initialAnnounceState(): AnnounceState {
  return { pending: [], windowStartedAt: null, spokenKeys: new Set() };
}

export type AnnounceDecision =
  | { speak: false }
  | { speak: true; item: FeedItem; text: string; priority: "assertive" | "polite"; key: string; spokenKeys: Set<string> };

// Register a change. Returns a decision to speak now if the coalescing window has
// elapsed, or to wait (the caller schedules a flush at `COALESCE_MS`). An item
// already spoken (same key, still in the feed) never speaks again.
export function registerChange(
  state: AnnounceState,
  items: readonly FeedItem[],
  now: number,
): { state: AnnounceState; decision: AnnounceDecision } {
  const fresh = items.filter((i) => !state.spokenKeys.has(itemKey(i)));
  if (fresh.length === 0) return { state, decision: { speak: false } };
  const windowStartedAt = state.windowStartedAt ?? now;
  const pending = [...state.pending, ...fresh];
  if (now - windowStartedAt < COALESCE_MS) {
    return { state: { ...state, pending, windowStartedAt }, decision: { speak: false } };
  }
  return { state: { ...state, pending, windowStartedAt }, decision: flush({ ...state, pending, windowStartedAt }) };
}

// Speak the most urgent item in the pending window, and stop tracking it.
export function flush(state: AnnounceState): AnnounceDecision {
  const item = mostUrgent(state.pending);
  if (item === null) return { speak: false };
  const key = itemKey(item);
  const spokenKeys = new Set(state.spokenKeys);
  spokenKeys.add(key);
  return {
    speak: true,
    item,
    text: announceText(item),
    priority: livePriority(state.pending),
    key,
    spokenKeys,
  };
}

// Apply a speak decision back into the state (the caller does this when its
// scheduled flush fires).
export function applySpoken(state: AnnounceState, decision: AnnounceDecision): AnnounceState {
  if (!decision.speak) return state;
  const remaining = state.pending.filter((i) => itemKey(i) !== decision.key);
  return { pending: remaining, windowStartedAt: remaining.length ? state.windowStartedAt : null, spokenKeys: decision.spokenKeys };
}

// --- Native notification gating (pure) ---------------------------------------

export interface Notifier {
  notify(payload: { title: string; body: string; threadId: number | null }): void;
}

// The notification decision for a feed change: for each worthy item not already
// notified and not the currently focused thread. Returns the notifications to
// send and the updated notified-key set.
export function planNotifications(
  notified: ReadonlySet<string>,
  items: readonly FeedItem[],
  focusedThreadId: number | null,
): { toNotify: FeedItem[]; notified: Set<string> } {
  const next = new Set(notified);
  const toNotify: FeedItem[] = [];
  for (const item of items) {
    if (!worthyOfNativeNotification(item)) continue;
    if (item.thread_id !== null && item.thread_id === focusedThreadId) continue; // looking at it already
    const key = itemKey(item);
    if (next.has(key)) continue;
    next.add(key);
    toNotify.push(item);
  }
  return { toNotify, notified: next };
}

export function notificationBody(item: FeedItem): { title: string; body: string; threadId: number | null } {
  return {
    title: item.kind === "approval" ? "Approval needed" : "Needs you",
    body: `${item.agent_name ?? "an agent"}: ${item.title}`,
    threadId: item.thread_id,
  };
}

// Feature-detect: build a Notifier from the desktop shell's notification
// surface when it exists; otherwise a no-op notifier (the web build). Never
// throws, never invents a channel.
export function desktopNotifier(shell: { notifications?: { show(payload: { title: string; body: string; threadId: number | null }): void } } | undefined): Notifier {
  const show = shell?.notifications?.show;
  if (typeof show !== "function") return { notify: () => {} };
  return { notify: (payload) => show(payload) };
}

// The bell badge change: what its live sub-node should say when the count moves.
// Empty when the count did not change, so the node stays silent otherwise (the
// count is already carried by the button's accessible name for the current value,
// this only announces the *change*).
export function bellCountAnnouncement(previous: number, next: number): string {
  if (previous === next) return "";
  if (next === 0) return "No unread notifications.";
  return `${next} unread notification${next === 1 ? "" : "s"}.`;
}
