import { canManageAgents, type Agent } from '@/lib/agents';
import {
  byteLength,
  describeSaveError,
  draftFromAgent,
  EMPTY_DRAFT,
  hasErrors,
  INSTRUCTIONS_MAX_BYTES,
  isDirty,
  toCreateBody,
  toUpdateBody,
  validateDraft,
} from '@/lib/agent-draft';
import { ApiError } from '@/lib/api';

const agent: Agent = {
  id: 4,
  name: 'Reviewer',
  title: 'Reviews pull requests',
  description: 'For me',
  provider: 'claude',
  model: null,
  approval_mode: 'plan',
  pinned: false,
  instructions: 'Be brief.',
  memory_enabled: true,
  workspace_path: '/home/me/project',
  fallback_provider: null,
  fallback_model: null,
};

describe('draftFromAgent', () => {
  it('reads an agent into the form fields and leaves out what the phone does not edit', () => {
    const draft = draftFromAgent(agent);
    expect(draft).toMatchObject({ name: 'Reviewer', title: 'Reviews pull requests', instructions: 'Be brief.', approval_mode: 'plan', model: null });
    expect(draft).not.toHaveProperty('workspace_path');
  });

  it('copes with an agent that has no optional fields and an unknown approval mode', () => {
    const draft = draftFromAgent({ id: 1, name: 'A', title: null, description: null, provider: 'codex', model: 'm', approval_mode: 'newer', pinned: false });
    expect(draft).toMatchObject({ title: '', description: '', instructions: '', approval_mode: 'ask', memory_enabled: true });
  });
});

describe('validateDraft', () => {
  it('needs a name and accepts a minimal draft', () => {
    expect(validateDraft(EMPTY_DRAFT).name).toBeTruthy();
    expect(hasErrors(validateDraft({ ...EMPTY_DRAFT, name: ' Ada ' }))).toBe(false);
    expect(validateDraft({ ...EMPTY_DRAFT, name: '   ' }).name).toBeTruthy();
  });

  it('applies the server limits, counting instructions in bytes', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'x'.repeat(81) }).name).toBeTruthy();
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'x'.repeat(80) }).name).toBeUndefined();
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', title: 'x'.repeat(201) }).title).toBeTruthy();
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', description: 'x'.repeat(4001) }).description).toBeTruthy();
    // 8,001 three-byte characters are 24,003 bytes: over the limit though far under 24,000 characters.
    const wide = '€'.repeat(8001);
    expect(byteLength(wide)).toBe(24_003);
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', instructions: wide }).instructions).toBeTruthy();
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', instructions: 'x'.repeat(INSTRUCTIONS_MAX_BYTES) }).instructions).toBeUndefined();
  });

  it('refuses a fallback engine that is the agent’s own', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', provider: 'claude', fallback_provider: 'claude' }).fallback).toBeTruthy();
    expect(validateDraft({ ...EMPTY_DRAFT, name: 'a', provider: 'claude', fallback_provider: 'codex' }).fallback).toBeUndefined();
  });
});

describe('isDirty', () => {
  const original = draftFromAgent(agent);

  it('is false for the same draft, also when only surrounding spaces differ in a name or title', () => {
    expect(isDirty({ ...original }, original)).toBe(false);
    expect(isDirty({ ...original, name: ' Reviewer ', title: 'Reviews pull requests ' }, original)).toBe(false);
  });

  it('is true when any field changes', () => {
    expect(isDirty({ ...original, instructions: 'Be long.' }, original)).toBe(true);
    expect(isDirty({ ...original, memory_enabled: false }, original)).toBe(true);
    expect(isDirty({ ...original, model: 'x' }, original)).toBe(true);
  });
});

describe('toCreateBody', () => {
  it('sends the name trimmed and leaves empty optional fields out, so the server’s defaults apply', () => {
    expect(toCreateBody({ ...EMPTY_DRAFT, name: ' Ada ' })).toEqual({
      name: 'Ada',
      instructions: '',
      provider: 'claude',
      model: null,
      approval_mode: 'ask',
      memory_enabled: true,
    });
  });

  it('includes what was filled in, and never a workspace folder, lead role or connected apps', () => {
    const body = toCreateBody({
      ...EMPTY_DRAFT,
      name: 'Ada',
      title: 'Researcher',
      description: 'Finds things',
      starter_notes: '- uses pnpm',
      fallback_provider: 'codex',
      fallback_model: 'gpt-x',
      approval_mode: 'plan',
    });
    expect(body).toMatchObject({ title: 'Researcher', description: 'Finds things', starter_notes: '- uses pnpm', fallback_provider: 'codex', fallback_model: 'gpt-x', approval_mode: 'plan' });
    for (const refused of ['workspace_path', 'make_lead', 'connector_scopes', 'connector_account_scopes']) expect(body).not.toHaveProperty(refused);
  });

  it('sends a fallback model only with a fallback engine', () => {
    expect(toCreateBody({ ...EMPTY_DRAFT, name: 'a', fallback_model: 'm' })).not.toHaveProperty('fallback_model');
  });
});

describe('toUpdateBody', () => {
  const original = draftFromAgent(agent);

  it('sends nothing for an unchanged draft', () => {
    expect(toUpdateBody({ ...original }, original)).toEqual({});
  });

  it('sends only what changed, so a setting the phone cannot change is never sent', () => {
    expect(toUpdateBody({ ...original, instructions: 'New.', approval_mode: 'ask' }, original)).toEqual({ instructions: 'New.', approval_mode: 'ask' });
  });

  it('clears a title or description with null', () => {
    expect(toUpdateBody({ ...original, title: '  ', description: '' }, original)).toEqual({ title: null, description: null });
  });

  it('names the model when the engine changes, so the server does not keep the old engine’s model', () => {
    expect(toUpdateBody({ ...original, provider: 'codex', model: null }, original)).toEqual({ provider: 'codex', model: null });
    expect(toUpdateBody({ ...original, provider: 'codex', model: 'gpt-x' }, original)).toEqual({ provider: 'codex', model: 'gpt-x' });
    expect(toUpdateBody({ ...original, model: 'opus' }, original)).toEqual({ model: 'opus' });
  });

  it('moves the fallback engine and its model together', () => {
    expect(toUpdateBody({ ...original, fallback_provider: 'codex', fallback_model: 'm' }, original)).toEqual({ fallback_provider: 'codex', fallback_model: 'm' });
    const withFallback = { ...original, fallback_provider: 'codex', fallback_model: 'm' };
    expect(toUpdateBody({ ...withFallback, fallback_provider: null, fallback_model: 'm' }, withFallback)).toEqual({ fallback_provider: null, fallback_model: null });
    expect(toUpdateBody({ ...withFallback, fallback_model: 'n' }, withFallback)).toEqual({ fallback_model: 'n' });
  });
});

describe('describeSaveError', () => {
  it('puts a taken name on the name field', () => {
    expect(describeSaveError(new ApiError(409, 'agent_name_taken', ''))).toMatchObject({ field: 'name' });
  });

  it('says what to do when the phone was not paired to manage agents, and when a setting is web-only', () => {
    expect(describeSaveError(new ApiError(403, 'scope_denied', '')).message).toMatch(/Chat, files and agents/);
    expect(describeSaveError(new ApiError(403, 'field_requires_admin', '')).message).toMatch(/web app/);
  });

  it('explains an engine the server does not have, and an unreadable 422', () => {
    expect(describeSaveError(new ApiError(422, 'unknown_provider', '')).message).toMatch(/engine or model/);
    expect(describeSaveError(new ApiError(422, null, '')).message).toMatch(/did not accept/);
  });

  it('falls back to the general message for anything else', () => {
    expect(describeSaveError(new ApiError(0, 'unreachable', '')).field).toBeNull();
    expect(describeSaveError(new Error('boom')).message).toBeTruthy();
  });
});

describe('canManageAgents', () => {
  it('is true only for a phone with the manage scope', () => {
    expect(canManageAgents(['chat', 'manage'])).toBe(true);
    expect(canManageAgents(['chat', 'files'])).toBe(false);
    expect(canManageAgents([])).toBe(false);
  });
});
