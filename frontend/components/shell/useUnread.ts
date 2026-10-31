"use client";

import { useEffect, useMemo, useState } from "react";
import type { Thread } from "@/lib/api";
import { isUnread, loadSeen, reconcileSeen, saveSeen, type SeenMap } from "@/lib/unread";

// The ids of conversations that moved since the person last opened them (per browser).
export function useUnread(threads: Thread[] | null, selectedId: number | null): Set<number> {
  const [seen, setSeen] = useState<SeenMap | null>(null);

  useEffect(() => {
    if (threads === null) return;
    const base = seen ?? loadSeen();
    const next = reconcileSeen(threads, base, selectedId);
    if (next !== base || seen === null) saveSeen(next);
    // Syncing with localStorage, an external store: the state must follow the stored map.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (next !== seen) setSeen(next);
  }, [threads, selectedId, seen]);

  return useMemo(() => {
    const ids = new Set<number>();
    if (threads === null || seen === null) return ids;
    for (const thread of threads) if (isUnread(thread, seen, selectedId)) ids.add(thread.id);
    return ids;
  }, [threads, selectedId, seen]);
}
