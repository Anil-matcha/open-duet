// Words for approvals, saved rules and the decision log. Pure: no React, no network.
import type { ApprovalRule, DecisionEntry, DecisionEvent, SentinelIssue } from "./api";

export const DECISION_EVENTS: { value: DecisionEvent; label: string }[] = [
  { value: "shown", label: "Asked" },
  { value: "allowed", label: "Allowed" },
  { value: "denied", label: "Denied" },
  { value: "auto_allowed", label: "Allowed by a saved rule" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
  { value: "undone", label: "Always-allow removed" },
];

export function decisionEventLabel(event: string): string {
  return DECISION_EVENTS.find((e) => e.value === event)?.label ?? event;
}

// One line saying what happened and who decided.
export function decisionText(entry: DecisionEntry): string {
  const what = entry.summary || entry.tool || "a tool call";
  switch (entry.event) {
    case "shown":
      return entry.rule?.startsWith("safety_floor:")
        ? `Asked about ${what} (a saved rule matched, but the safety floor holds it for you)`
        : `Asked about ${what}`;
    case "allowed":
      return entry.remembered ? `You allowed ${what} and chose to always allow it` : `You allowed ${what}`;
    case "denied":
      return entry.source === "plan_mode" ? `${what} was refused: plan only changes nothing` : `You denied ${what}`;
    case "auto_allowed":
      if (entry.source === "screen_turn_grant") return `${what} ran with your screen permission for this turn`;
      if (entry.source === "computer_screen_read") return `${what} ran without asking: reading the computer screen`;
      if (entry.source === "computer_browser_read") return `${what} ran without asking: reading the agent's browser`;
      if (entry.source === "computer_read") return `${what} ran without asking: reading inside the agent's computer`;
      if (entry.source === "accept_edits") return `${what} ran without asking: edits are accepted for this agent`;
      return `${what} ran without asking: a saved rule allowed it`;
    case "expired":
      return `Nobody answered about ${what} in time, so it did not run`;
    case "cancelled":
      return `The question about ${what} was withdrawn`;
    case "undone":
      return `You stopped always allowing ${ruleCommand(entry.rule) || "a command"}`;
    default:
      return what;
  }
}

// "exact@/work: git status" -> "git status".
export function ruleCommand(rule: string | null | undefined): string {
  if (!rule) return "";
  const at = rule.indexOf(": ");
  return at === -1 ? rule : rule.slice(at + 2);
}

export function ruleMatchLabel(rule: Pick<ApprovalRule, "match">): string {
  return rule.match === "prefix" ? "Starts with" : "Exactly";
}

export function ruleScopeLabel(rule: Pick<ApprovalRule, "workspace">): string {
  return rule.workspace ? `In ${rule.workspace}` : "In every folder";
}

// The card offers "Always allow this command" only where the backend can save
// one: a shell command with text.
export function canAlwaysAllow(tool: string, input: Record<string, unknown>): boolean {
  const command = input.command;
  // A computer's exec tool is a shell command too; its rules match the same way.
  return (tool === "Bash" || tool === "mcp__computer__exec") && typeof command === "string" && command.trim() !== "";
}

export function csvFileName(threadId: number | null | undefined, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return threadId != null ? `decisions-thread-${threadId}-${day}.csv` : `decisions-${day}.csv`;
}

const ISSUE_KIND: Record<SentinelIssue["kind"], string> = {
  retry_loop: "Retry loop",
  repeated_denial: "Asked again after a denial",
  tool_error: "Tool error",
  turn_failure: "Failed answer",
};

export function issueKindLabel(kind: string): string {
  return ISSUE_KIND[kind as SentinelIssue["kind"]] ?? kind;
}

export function isScreenInput(tool: string): boolean {
  return /^mcp__computer__(click|double_click|move|drag|type|key|scroll|browser_(open|click|fill|type|press|tabs|dialog|restart|close))$/.test(tool);
}

// --- Explain projection: pure shaping of the payload the endpoint returns -----
// The card renders these; it never re-derives a verdict, matches a rule or reads
// the floor. Every field below comes from the payload, verbatim.

import type { ExplainPayload, ExplainFloorVerdict, RulePreview } from "./api";

// The resolved command as one line: the argv joined, with the wrapper steps the
// backend reported annotated so the reader sees what was stripped.
export function resolvedCommandText(payload: ExplainPayload): string {
  const argv = payload.resolved_argv.length ? payload.resolved_argv.join(" ") : payload.command;
  if (!payload.wrapper_chain.length) return argv;
  const steps = payload.value_options_resolved.map(([opt, value]) => `${opt} ${value}`);
  const through = steps.length ? `${payload.wrapper_chain.join(" → ")} (${steps.join(", ")})` : payload.wrapper_chain.join(" → ");
  return `${argv}\nthrough ${through}`;
}

// The matched rule as one line, or an explicit "no saved rule".
export function matchedRuleText(rule: ExplainPayload["matched_rule"]): string {
  if (rule === null) return "No saved rule";
  const scope = rule.workspace ? `in ${rule.workspace}` : "in every folder";
  return `${rule.kind === "prefix" ? "Starts with" : "Exactly"} “${rule.command}” ${scope}`;
}

export type FloorBadge = { clear: boolean; label: string; detail: string | null };

// The floor verdict as a badge: green when clear, red with the tripped check
// (or the reason it could not be read) otherwise. Never locally recomputed.
export function floorBadge(verdict: ExplainFloorVerdict): FloorBadge {
  if (verdict.clear) return { clear: true, label: "Safe floor check passed", detail: null };
  const detail = verdict.tripped_check
    ? `${verdict.tripped_check}${verdict.reason ? `: ${verdict.reason}` : ""}`
    : verdict.skipped_reason ?? "held for a person";
  return { clear: false, label: "Held by the safety floor", detail };
}

// Whether the "also allows" list should start expanded (≥ 1 entry).
export function alsoAllowsExpanded(payload: ExplainPayload): boolean {
  return payload.also_allows.length > 0;
}

// The whole card model. `null` payload is the degrade state (explain fetch
// failed): the card falls back to the legacy view plus a visible banner.
export type ExplainView =
  | { state: "loading" }
  | { state: "unavailable"; banner: string }
  | { state: "ready"; payload: ExplainPayload; sections: {
      resolvedCommand: string;
      matchedRule: string;
      floor: FloorBadge;
      alsoAllows: string[];
      alsoAllowsExpanded: boolean;
    } };

export function explainView(payload: ExplainPayload | null, opts: { loading?: boolean; failed?: boolean } = {}): ExplainView {
  if (opts.loading) return { state: "loading" };
  if (opts.failed || payload === null) {
    return { state: "unavailable", banner: "Explanation unavailable — showing the command only." };
  }
  return {
    state: "ready",
    payload,
    sections: {
      resolvedCommand: resolvedCommandText(payload),
      matchedRule: matchedRuleText(payload.matched_rule),
      floor: floorBadge(payload.floor_verdict),
      alsoAllows: payload.also_allows,
      alsoAllowsExpanded: alsoAllowsExpanded(payload),
    },
  };
}

// --- Batch approve: gating + fan-out planning -------------------------------

export type BatchCandidate = { id: string; tool: string; floorClear: boolean | null };

export type BatchGate = { enabled: boolean; reason: string | null; count: number };

// The batch action is enabled only when the selection is non-empty, homogeneous
// in tool, and every item is explain-confirmed floor-clear (the anti-rubber-stamp
// property). `floorClear === null` (not yet explained) counts as not clear.
export function batchGate(selection: BatchCandidate[]): BatchGate {
  const count = selection.length;
  if (count === 0) return { enabled: false, reason: "Select at least one request to approve together.", count };
  const tools = new Set(selection.map((s) => s.tool));
  if (tools.size > 1) return { enabled: false, reason: "Mixed tool types cannot be approved together.", count };
  const unclear = selection.filter((s) => s.floorClear !== true);
  if (unclear.length > 0) {
    return { enabled: false, reason: `${unclear.length} selected item(s) are not safe-floor, so approval stays one by one.`, count };
  }
  return { enabled: true, reason: null, count };
}

export type BatchOutcome = { id: string; ok: boolean; error: string | null };

// Fan out one accept call per selected item and report per item. A failure is
// recorded for that item; the others still run. Nothing is swallowed.
export async function runBatchApprove(
  selection: { id: string }[],
  accept: (id: string) => Promise<unknown>
): Promise<BatchOutcome[]> {
  const outcomes: BatchOutcome[] = [];
  for (const item of selection) {
    try {
      await accept(item.id);
      outcomes.push({ id: item.id, ok: true, error: null });
    } catch (err) {
      outcomes.push({ id: item.id, ok: false, error: err instanceof Error ? err.message : "Could not approve." });
    }
  }
  return outcomes;
}

// The preview payload as displayed on the rules screen, before save is allowed.
export type PreviewView = { canSave: boolean; wouldAllow: string[]; wouldReject: string[]; floorLabel: string };

export function previewView(preview: RulePreview | null, opts: { error?: string | null } = {}): PreviewView {
  if (preview === null) {
    return { canSave: false, wouldAllow: [], wouldReject: [], floorLabel: opts.error ? `Cannot preview: ${opts.error}` : "No preview yet" };
  }
  return {
    // Save is gated on a preview having run and the candidate clearing the floor.
    canSave: preview.floor_state.clear,
    wouldAllow: preview.would_allow,
    wouldReject: preview.would_reject,
    floorLabel: floorBadge(preview.floor_state).label,
  };
}

