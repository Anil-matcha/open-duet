"use client";

import { cn } from "@/lib/cn";
import { buildResumeSummary, phaseLabel, type ReplayPhase, type ResumeEvent } from "@/lib/resume-summary";
import { Button } from "@/components/ui/Button";

// The guided-resume surface on an interrupted turn: the recorded replay phase,
// the last events of that turn, and one action that composes a continuation.
// The action only calls `onComposeContinuation` (the owner fills the composer);
// it NEVER posts a turn — resending stays the composer's own submit, which keeps
// the no-auto-replay invariant intact.
export function ResumeCard({
  events,
  phase,
  turnId,
  onComposeContinuation,
}: {
  events: readonly ResumeEvent[];
  phase: ReplayPhase;
  turnId: number | null;
  onComposeContinuation: (summary: string) => void;
}) {
  const summary = buildResumeSummary(events, phase, turnId);
  return (
    <div className="space-y-2 rounded-card border border-line bg-raised/40 p-3.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Interrupted before finishing</span>
        <span className="rounded-full bg-inset px-2 py-0.5 font-mono text-xs text-ink" title="How far the turn had got when it stopped">
          {phaseLabel(phase)}
        </span>
      </div>
      <div>
        <p className="text-xs font-medium text-muted">Last recorded activity</p>
        {summary.hasEvents ? (
          <ul className="mt-0.5 space-y-0.5">
            {summary.lines.map((line, index) => (
              <li key={index} className="break-words font-mono text-xs text-ink">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className={cn("mt-0.5 text-xs text-muted")}>No recorded activity for this turn.</p>
        )}
      </div>
      <Button
        variant="primary"
        onClick={() => onComposeContinuation(summary.text)}
        title="Fill the message box with a summary you can review and send; nothing is sent for you"
      >
        Compose continuation
      </Button>
    </div>
  );
}
