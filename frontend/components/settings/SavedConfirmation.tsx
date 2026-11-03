"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Timer = ReturnType<typeof setTimeout>;

export function useSavedConfirmation(duration = 2400) {
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const timers = useRef(new Map<string, Timer>());

  const clearSaved = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    setSaved((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const showSaved = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    setSaved((current) => new Set(current).add(key));
    timers.current.set(key, setTimeout(() => {
      timers.current.delete(key);
      setSaved((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }, duration));
  }, [duration]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  return { saved, showSaved, clearSaved };
}

export function SavedConfirmation({ visible }: { visible: boolean }) {
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="text-xs text-success">
      {visible ? "Saved" : ""}
    </span>
  );
}
