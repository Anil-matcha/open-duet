import type { Agent, Engine } from "@/lib/api";

export const AGENT_SEARCH_THRESHOLD = 6;

export function shouldShowAgentSearch(count: number): boolean {
  return count > AGENT_SEARCH_THRESHOLD;
}

export function unavailableEnginesInUse(
  agents: Pick<Agent, "provider">[],
  engines: Pick<Engine, "id" | "available" | "label" | "reason" | "signed_in">[],
) {
  const inUse = new Set(agents.map((agent) => agent.provider));
  return engines.filter((engine) => inUse.has(engine.id) && !engine.available);
}

// Use the description first, then the short role line for compact list previews.
export function agentOneLineDescription(agent: Pick<Agent, "description" | "title">): string {
  return agent.description?.trim() || agent.title?.trim() || "";
}

export function filterAgents(agents: Agent[], query: string, engineLabels: Map<string, string>): Agent[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return agents;
  return agents.filter((agent) => [
    agent.name,
    agent.title,
    agent.description,
    agent.instructions,
    agent.provider,
    engineLabels.get(agent.provider),
    agent.model,
    agent.approval_mode,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized)));
}
