// What the phone shows about an agent. An agent is a named setup on the server (instructions, engine,
// model, how it asks before acting); the phone only picks one to start a conversation from. Editing
// agents stays in the web app.

export type Agent = {
  id: number;
  name: string;
  title: string | null;
  description: string | null;
  provider: string;
  model: string | null;
  approval_mode: string;
  pinned: boolean;
};

// The same words the web app uses for how an agent asks before it acts.
const APPROVAL_MODES: Record<string, string> = {
  ask: 'Asks before acting',
  accept_edits: 'Accepts file edits',
  plan: 'Plans only',
};

export function approvalModeLabel(mode: string): string {
  return APPROVAL_MODES[mode] ?? mode;
}

/** One line under an agent's name: its title or description, else engine and model. */
export function agentSummary(agent: Agent): string {
  const about = agent.title?.trim() || agent.description?.trim();
  return about || [agent.provider, agent.model].filter(Boolean).join(' · ');
}

/** The conversation list names the agent a conversation came from; a deleted agent falls back to the engine. */
export function agentName(agents: Agent[], agentId: number | null | undefined): string | null {
  if (agentId === null || agentId === undefined) return null;
  return agents.find((agent) => agent.id === agentId)?.name ?? null;
}
