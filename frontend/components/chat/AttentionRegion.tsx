"use client";

import { useEffect, useRef, useState } from "react";
import {
  applySpoken,
  COALESCE_MS,
  flush,
  initialAnnounceState,
  planNotifications,
  notificationBody,
  registerChange,
  type FeedItem,
  type Notifier,
} from "@/lib/attention";

// The one app-root live region. It renders EMPTY on mount — the node exists
// before any content is ever set, which is the invariant screen readers need to
// announce the *change* — and its text is filled only when a pending-work change
// arrives. Announcements coalesce within COALESCE_MS; the most urgent item wins.
//
// Native notifications are sent (feature-detected) only for expired/due items,
// deduplicated per item, never for the thread the person is currently reading.
export function AttentionRegion({
  items,
  focusedThreadId = null,
  notifier,
}: {
  items: readonly FeedItem[];
  focusedThreadId?: number | null;
  notifier?: Notifier;
}) {
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<"assertive" | "polite">("polite");
  const state = useRef(initialAnnounceState());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notified = useRef<Set<string>>(new Set());
  // The set of item keys present last render: an item leaving the feed clears its
  // notification tombstone so a later re-arrival notifies again.
  const present = useRef<Set<string>>(new Set());

  useEffect(() => {
    const keys = new Set(items.map((i) => `${i.kind}:${i.thread_id ?? "none"}:${i.agent_name ?? ""}:${i.title}`));
    for (const key of notified.current) if (!keys.has(key)) notified.current.delete(key);
    present.current = keys;

    const now = Date.now();
    const { state: nextState, decision } = registerChange(state.current, items, now);
    state.current = nextState;

    if (decision.speak) {
      state.current = applySpoken(state.current, decision);
      setText(decision.text);
      setPriority(decision.priority);
    } else if (nextState.pending.length > 0 && timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        const spoken = flush(state.current);
        state.current = applySpoken(state.current, spoken);
        if (spoken.speak) {
          setText(spoken.text);
          setPriority(spoken.priority);
        }
      }, COALESCE_MS);
    }

    // Native notifications: gated to urgent items, deduped, focus-suppressed.
    if (notifier) {
      const plan = planNotifications(notified.current, items, focusedThreadId);
      notified.current = plan.notified;
      for (const item of plan.toNotify) notifier.notify(notificationBody(item));
    }
  }, [items, focusedThreadId, notifier]);

  return (
    <div role="status" aria-live={priority} aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
