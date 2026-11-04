"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type PendingWorkItem } from "@/lib/api";

export type PendingWork = {
  items: PendingWorkItem[];
  // True until the first successful read (or the first change frame).
  loading: boolean;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// The owner's pending work across every thread. Subscribes to the change stream
// and re-reads the feed on each change frame (the frame carries a summary, never
// the full set); falls back to polling when the stream is unavailable, so the
// surface still works on an older backend.
export function usePendingWork(pollMs = 15_000): PendingWork {
  const [state, setState] = useState<PendingWork>({ items: [], loading: true });
  const refreshing = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    const read = async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      try {
        const feed = await api.pendingWork();
        if (!controller.signal.aborted) setState({ items: feed.items, loading: false });
      } catch {
        // A failed read leaves the last known set; the stream or the poll retries.
        if (!controller.signal.aborted) setState((prev) => ({ ...prev, loading: false }));
      } finally {
        refreshing.current = false;
      }
    };

    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, pollMs);

    (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          await api.streamPendingWork(() => { void read(); }, controller.signal, () => { delay = 1000; });
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return; // stream not offered; polling remains
        }
        if (controller.signal.aborted) return;
        await sleep(delay, controller.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => { controller.abort(); clearInterval(timer); };
  }, [pollMs]);

  return state;
}
