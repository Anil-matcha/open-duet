"use client";

import { Clock, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { formatElapsed, type WorkingPhase } from "@/lib/working-status";

// When each turn was first seen working, so the timer survives this component unmounting
// (it is hidden while the answer streams) and carries on if the turn goes back to working.
const started = new Map<number, number>();
function startOf(turnId: number): number {
  let at = started.get(turnId);
  if (at === undefined) {
    at = Date.now();
    started.set(turnId, at);
    if (started.size > 50) started.delete(started.keys().next().value as number);
  }
  return at;
}

// "Thinking · 12s", "Using Bash · 1m 05s" or "Waiting for you". The timer runs from when the turn
// was first seen working and only ticks while visible. Motion stops for people who ask for less.
export function WorkingStatus({ phase, turnId }: { phase: WorkingPhase; turnId: number }) {
  const [startedAt] = useState(() => startOf(turnId));
  const [now, setNow] = useState(() => Date.now());
  const waiting = phase.kind === "waiting";
  useEffect(() => {
    if (waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);
  const label =
    phase.kind === "waiting" ? t("chat.working.waiting") : phase.kind === "tool" ? t("chat.working.tool", { name: phase.name }) : t("chat.working.thinking");
  return (
    <p className="flex items-center gap-2 text-xs text-muted" role="status" aria-label={label}>
      {waiting ? (
        <Clock size={13} aria-hidden="true" className="text-warning" />
      ) : (
        <Loader2 size={13} aria-hidden="true" className="animate-spin text-faint motion-reduce:animate-none" />
      )}
      <span className={waiting ? "" : "animate-pulse motion-reduce:animate-none"}>{label}…</span>
      {!waiting && <span className="tabular-nums text-faint" aria-hidden="true">{formatElapsed((now - startedAt) / 1000)}</span>}
    </p>
  );
}
