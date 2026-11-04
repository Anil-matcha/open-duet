// The form behind creating and editing an agent on the phone: its fields, the server's limits, what is sent
// and how a refusal is put into words. The fields and wording follow the web editor (frontend/components/chat/
// AgentsPanel.tsx). What the phone leaves out on purpose, and the server refuses to a phone: the workspace
// folder, "Accept edits", connected apps, the team lead role, skills, notes editing, computers.

import type { Agent, ApprovalMode } from './agents';
import { ApiError, describeApiError } from './api';

export const NAME_MAX = 80;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 4000;
/** Bytes, not characters, so the limit means the same in every language (backend/app/schemas/agent.py). */
export const INSTRUCTIONS_MAX_BYTES = 24_000;
export const STARTER_NOTES_MAX = 256 * 1024;

/** The modes a phone may set. "Accept edits" is kept for display only: the server refuses it from a phone. */
export const PHONE_APPROVAL_MODES: ApprovalMode[] = ['ask', 'plan'];

export type AgentDraft = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  provider: string;
  /** null is the engine's own default model. */
  model: string | null;
  approval_mode: ApprovalMode;
  memory_enabled: boolean;
  /** The agent's first notes; only when creating. */
  starter_notes: string;
  fallback_provider: string | null;
  fallback_model: string | null;
};

export const EMPTY_DRAFT: AgentDraft = {
  name: '',
  title: '',
  description: '',
  instructions: '',
  provider: 'claude',
  model: null,
  approval_mode: 'ask',
  memory_enabled: true,
  starter_notes: '',
  fallback_provider: null,
  fallback_model: null,
};

function asMode(mode: string): ApprovalMode {
  return mode === 'accept_edits' || mode === 'plan' ? mode : 'ask';
}

export function draftFromAgent(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    title: agent.title ?? '',
    description: agent.description ?? '',
    instructions: agent.instructions ?? '',
    provider: agent.provider,
    model: agent.model,
    approval_mode: asMode(agent.approval_mode),
    memory_enabled: agent.memory_enabled ?? true,
    starter_notes: '',
    fallback_provider: agent.fallback_provider ?? null,
    fallback_model: agent.fallback_model ?? null,
  };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type DraftErrors = Partial<Record<'name' | 'title' | 'description' | 'instructions' | 'starter_notes' | 'fallback', string>>;

/** What the server would refuse, found before anything is sent. Empty means the draft can be saved. */
export function validateDraft(draft: AgentDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Give the agent a name.';
  else if (name.length > NAME_MAX) errors.name = `Use at most ${NAME_MAX} characters.`;
  if (draft.title.length > TITLE_MAX) errors.title = `Use at most ${TITLE_MAX} characters.`;
  if (draft.description.length > DESCRIPTION_MAX) errors.description = `Use at most ${DESCRIPTION_MAX} characters.`;
  if (byteLength(draft.instructions) > INSTRUCTIONS_MAX_BYTES) errors.instructions = `Instructions are limited to ${INSTRUCTIONS_MAX_BYTES} bytes.`;
  if (draft.starter_notes.length > STARTER_NOTES_MAX) errors.starter_notes = 'These notes are too long.';
  if (draft.fallback_provider && draft.fallback_provider === draft.provider) errors.fallback = 'The fallback engine must differ from the agent’s engine.';
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Equal drafts compare equal however the fields were typed: names and titles are compared trimmed. */
export function isDirty(draft: AgentDraft, original: AgentDraft): boolean {
  return (Object.keys(original) as (keyof AgentDraft)[]).some((key) => {
    const a = draft[key];
    const b = original[key];
    return typeof a === 'string' && typeof b === 'string' && (key === 'name' || key === 'title') ? a.trim() !== b.trim() : a !== b;
  });
}

/** The body of a new agent. Empty optional text is left out so the server's defaults apply. */
export function toCreateBody(draft: AgentDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    instructions: draft.instructions,
    provider: draft.provider,
    model: draft.model,
    approval_mode: draft.approval_mode,
    memory_enabled: draft.memory_enabled,
  };
  if (draft.title.trim()) body.title = draft.title.trim();
  if (draft.description.trim()) body.description = draft.description;
  if (draft.starter_notes.trim()) body.starter_notes = draft.starter_notes;
  if (draft.fallback_provider) {
    body.fallback_provider = draft.fallback_provider;
    if (draft.fallback_model) body.fallback_model = draft.fallback_model;
  }
  return body;
}

/**
 * Only what changed, so an edit never sends a setting the person did not touch (in particular nothing the server
 * refuses to a phone, such as the workspace folder). A cleared title or description is sent as null.
 */
export function toUpdateBody(draft: AgentDraft, original: AgentDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== original.name.trim()) body.name = draft.name.trim();
  if (draft.title.trim() !== original.title.trim()) body.title = draft.title.trim() || null;
  if (draft.description !== original.description) body.description = draft.description.trim() ? draft.description : null;
  if (draft.instructions !== original.instructions) body.instructions = draft.instructions;
  if (draft.provider !== original.provider) body.provider = draft.provider;
  // A new engine resets the model on the server unless one is named; name it when it was chosen, or when only the model moved.
  if (draft.model !== original.model || draft.provider !== original.provider) body.model = draft.model;
  if (draft.approval_mode !== original.approval_mode) body.approval_mode = draft.approval_mode;
  if (draft.memory_enabled !== original.memory_enabled) body.memory_enabled = draft.memory_enabled;
  if (draft.fallback_provider !== original.fallback_provider) {
    body.fallback_provider = draft.fallback_provider;
    body.fallback_model = draft.fallback_provider ? draft.fallback_model : null;
  } else if (draft.fallback_model !== original.fallback_model) {
    body.fallback_model = draft.fallback_model;
  }
  return body;
}

export type SaveProblem = { field: 'name' | null; message: string };

/** A refused save in words a person can act on. A name already in use belongs to the name field. */
export function describeSaveError(error: unknown): SaveProblem {
  if (error instanceof ApiError) {
    switch (error.errorCode) {
      case 'agent_name_taken':
        return { field: 'name', message: 'You already have an agent with this name. Choose another.' };
      case 'unknown_provider':
      case 'unknown_model':
        return { field: null, message: 'Your server does not have that engine or model. Choose another.' };
      case 'field_requires_admin':
        return { field: null, message: 'That setting can only be changed in the web app.' };
      case 'scope_denied':
        return { field: null, message: 'This phone was not paired to manage agents. Pair it again with a “Chat, files and agents” code.' };
      case 'engine_without_computers':
        return { field: null, message: 'This agent has a computer, and that engine cannot use it. Choose another engine, or change it in the web app.' };
      case 'lead_engine':
        return { field: null, message: 'This agent leads a team, which needs Claude or Codex. Change that in the web app.' };
    }
    if (error.status === 422) return { field: null, message: 'The server did not accept these settings. Check the fields and try again.' };
  }
  return { field: null, message: describeApiError(error) };
}

/** One sentence per thing a save changes for conversations already started (backend/app/routers/agents.py, update_agent). */
export const SAVE_IMPACT_NOTES = [
  'A new model or approval mode applies to existing conversations from their next message. A conversation keeps the engine it started on.',
  'New instructions and notes are sent with every message, but in practice reach only conversations started after the change.',
];
