// What the phone shows about an agent. An agent is a named setup on the server (instructions, engine,
// model, how it asks before acting). Any paired phone can pick one to start a conversation from; a phone
// paired with "Chat, files and agents" can also create and edit them (lib/agent-draft.ts, app/agents/).

export type Agent = {
  id: number;
  name: string;
  title: string | null;
  description: string | null;
  provider: string;
  model: string | null;
  approval_mode: string;
  pinned: boolean;
  // Only on a full agent from the server; a list built by an older test or screen may not have them.
  instructions?: string;
  memory_enabled?: boolean;
  workspace_path?: string | null;
  fallback_provider?: string | null;
  fallback_model?: string | null;
  archived_at?: string | null;
};

export type ApprovalMode = 'ask' | 'accept_edits' | 'plan';

// The same words the web app uses for how an agent asks before it acts (frontend/lib/agents.ts).
export const APPROVAL_OPTIONS: { value: ApprovalMode; label: string; description: string }[] = [
  { value: 'ask', label: 'Ask first', description: 'Your agent asks before it writes a file or runs a command. Reading is allowed.' },
  { value: 'accept_edits', label: 'Accept edits', description: 'File edits go ahead without asking. Commands still ask first.' },
  { value: 'plan', label: 'Plan only', description: 'Your agent looks around and writes a plan, but changes nothing.' },
];

export function approvalModeLabel(mode: string): string {
  return APPROVAL_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

/** True for a phone paired to create and edit agents ("Chat, files and agents"). The server enforces it; this only decides what to show. */
export function canManageAgents(scopes: readonly string[]): boolean {
  return scopes.includes('manage');
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
