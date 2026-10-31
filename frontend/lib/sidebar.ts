// Rules for the sidebar's lists, with no runtime imports so node tests can load them.

type ThreadLike = { id: number; agent_id?: number | null; archived_at: string | null; updated_at: string };
type AgentLike = { id: number; name: string; pinned?: boolean; archived_at: string | null };

// Where an agent's row in the sidebar leads: its most recently active conversation that is not
// archived, or a new chat started with it when it has none.
export function agentTarget(threads: readonly ThreadLike[] | null, agentId: number): { kind: "thread"; id: number } | { kind: "new" } {
  let best: ThreadLike | null = null;
  for (const thread of threads ?? []) {
    if (thread.agent_id !== agentId || thread.archived_at !== null) continue;
    if (best === null || Date.parse(thread.updated_at) > Date.parse(best.updated_at)) best = thread;
  }
  return best ? { kind: "thread", id: best.id } : { kind: "new" };
}

// The agents to list: archived ones left out, pinned first, then by name (case-insensitive).
export function sidebarAgents<T extends AgentLike>(agents: readonly T[] | null): T[] {
  return (agents ?? [])
    .filter((agent) => agent.archived_at === null)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export type RowStatus = "waiting" | "working" | "reset" | "unread" | null;

// What a row shows when several things are true at once. Waiting on the person outranks
// everything because only they can move it on; a conversation that needs a new session is
// next to useless until fixed; unread is the quietest, shown alone only when nothing else is.
export function rowStatus(state: { waiting?: boolean; working?: boolean; brokenSession?: boolean; unread?: boolean }): RowStatus {
  if (state.waiting) return "waiting";
  if (state.working) return "working";
  if (state.brokenSession) return "reset";
  if (state.unread) return "unread";
  return null;
}

// Unread alongside a louder status gets its own small accent dot next to it.
export function showsUnreadDot(status: RowStatus, unread: boolean): boolean {
  return unread && status !== null && status !== "unread";
}

// The short default Recent list: the newest `limit` conversations, plus any that need attention
// (kept by `keep`), in their original order. `showAll` lifts the limit.
export function recentVisible<T extends { id: number }>(threads: readonly T[], limit: number, keep: (thread: T) => boolean, showAll: boolean): T[] {
  if (showAll || threads.length <= limit) return [...threads];
  let plain = 0;
  return threads.filter((thread) => {
    if (keep(thread)) return true;
    plain += 1;
    return plain <= limit;
  });
}
