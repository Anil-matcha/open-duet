// Guided resume: build a factual continuation summary for an interrupted turn,
// from that turn's stored transcript items only. Pure — the component and the
// composer prefill are thin consumers, so the wording contract is unit-testable.
//
// Wording discipline: the summary never claims completion. The negative clause
// ("It did not finish.") is template-fixed, not derived, and derived lines fail
// closed — missing data renders a placeholder, never an optimistic line.

export type ReplayPhase = "before_accept" | "after_accept" | "unknown" | "";

// The subset of a transcript item the digest reads. Kept structural so the
// caller can pass transcript items without importing the full union here.
export type ResumeEvent = {
  kind: string;
  turnId: number | null;
  // For tool items: the tool name; for user items: the prompt text.
  tool?: string;
  text?: string;
  summary?: string;
};

const UNAVAILABLE = "(details unavailable)";

// A human phrase for the stored replay phase. `unknown` renders as unknown,
// never inferred; an empty phase is stated as not recorded.
export function phaseLabel(phase: ReplayPhase): string {
  switch (phase) {
    case "before_accept":
      return "before_accept";
    case "after_accept":
      return "after_accept";
    case "unknown":
      return "unknown";
    default:
      return "unknown (not recorded)";
  }
}

// One digest line per stored event that shows what ran. Tool calls name the
// tool; the turn's own prompt is not repeated as "work done". Secrets never
// reach here: the backend redacts event data before it is persisted.
export function eventLines(events: readonly ResumeEvent[], turnId: number | null): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (turnId !== null && event.turnId !== null && event.turnId !== turnId) continue;
    if (event.kind === "tool") {
      const name = event.tool?.trim();
      lines.push(name ? `ran ${name}` : `ran a tool ${UNAVAILABLE}`);
    } else if (event.kind === "assistant") {
      const text = event.text?.trim();
      if (text) lines.push(`wrote a reply`);
    }
  }
  return lines;
}

export type ResumeSummary = {
  text: string;
  phase: ReplayPhase;
  lines: string[];
  hasEvents: boolean;
};

// The summary the composer is prefilled with. Deterministic; no model call.
export function buildResumeSummary(events: readonly ResumeEvent[], phase: ReplayPhase, turnId: number | null): ResumeSummary {
  const lines = eventLines(events, turnId);
  const digest = lines.length > 0 ? lines.join("; ") : UNAVAILABLE;
  const text = `Restarting after an interruption: the previous turn reached ${phaseLabel(phase)}. It had run: ${digest}. It did not finish.`;
  return { text, phase, lines, hasEvents: lines.length > 0 };
}

// Whether the resume surface should appear: the latest turn ended interrupted.
// (Per-state mapping lives in the caller; this is the eligibility predicate.)
export function isInterrupted(status: string): boolean {
  return status === "interrupted";
}

// The completion-claim words the summary must never contain. The template
// contract test asserts the generated text is free of them.
export const FORBIDDEN_COMPLETION_WORDS = ["completed", "complete", "successfully", "success", "finished successfully"] as const;

export function claimsCompletion(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN_COMPLETION_WORDS) {
    if (lower.includes(word)) return word;
  }
  return null;
}

// The fixed negative clause, exported so the contract test can pin it.
export const NEGATIVE_CLAUSE = "It did not finish.";
