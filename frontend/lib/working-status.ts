// What to say while an answer is being worked on: the phase, and how long it has taken.
import type { TranscriptItem } from "./transcript";

export type WorkingPhase = { kind: "thinking" } | { kind: "tool"; name: string } | { kind: "waiting" };

export function workingPhase(items: TranscriptItem[]): WorkingPhase {
  if (items.some((i) => i.kind === "approval" && i.status === "pending")) return { kind: "waiting" };
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool" && item.state === "running") return { kind: "tool", name: item.name };
    // Anything else after the last running tool (a message, a turn end) means it is not in a tool now.
    if (item.kind === "assistant" || item.kind === "user" || item.kind === "turn_end") break;
  }
  return { kind: "thinking" };
}

// 7s, 1m 05s, 12m 00s.
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
