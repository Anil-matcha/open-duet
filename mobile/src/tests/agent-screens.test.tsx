import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';

import AgentEditor from '../app/agents/[id]';
import Agents from '../app/agents';
import Settings from '../app/settings';
import { Button, PickerField, RadioGroup, SwitchRow } from '@/components/form';
import type { Agent } from '@/lib/agents';
import { ApiError } from '@/lib/api';
import { readEngines } from '@/lib/engines';
import { touch } from '@/lib/theme';

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: { id: string } = { id: 'new' };
let mockScopes: string[] = ['chat', 'manage'];
let mockPrevent: { active: boolean; callback?: (options: { repeat: () => void }) => void } = { active: false };

const mockApi = {
  listAgents: jest.fn(),
  getAgent: jest.fn(),
  createAgent: jest.fn(),
  updateAgent: jest.fn(),
  duplicateAgent: jest.fn(),
  listEngines: jest.fn(),
};

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => ({ push: mockPush, back: mockBack }),
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
    usePreventRemove: (active: boolean, callback: (options: { repeat: () => void }) => void) => {
      mockPrevent = { active, callback };
    },
  };
});
jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    state: { status: 'paired', server: 'https://dots.example.com', token: 't', label: 'My phone', scopes: mockScopes },
    signOut: jest.fn(),
  }),
}));
jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));

const agent = (id: number, name: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name,
  title: null,
  description: null,
  provider: 'claude',
  model: null,
  approval_mode: 'ask',
  pinned: false,
  instructions: '',
  memory_enabled: true,
  workspace_path: null,
  ...extra,
});

const engines = [
  { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus', default: false }, { id: 'sonnet', label: 'Sonnet', default: true }], default_model: 'sonnet', custom_models: false, capabilities: { computers: true } },
  { id: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-x', label: 'GPT X', default: true }], default_model: 'gpt-x', custom_models: false, capabilities: { computers: false } },
  { id: 'gemini', label: 'Gemini', available: false, reason: 'Not signed in', models: [], custom_models: false, capabilities: {} },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { id: 'new' };
  mockScopes = ['chat', 'manage'];
  mockPrevent = { active: false };
  mockApi.listAgents.mockResolvedValue([]);
  mockApi.listEngines.mockResolvedValue(readEngines(engines));
  mockApi.createAgent.mockResolvedValue(agent(9, 'Ada'));
  mockApi.updateAgent.mockResolvedValue(agent(4, 'Reviewer'));
  mockApi.duplicateAgent.mockResolvedValue(agent(10, 'Reviewer copy'));
});

describe('Agents list', () => {
  it('says how to pair again when this phone was not paired to manage agents', async () => {
    mockScopes = ['chat', 'files'];
    await render(<Agents />);
    expect(screen.getByText(/Chat, files and agents/)).toBeTruthy();
    expect(mockApi.listAgents).not.toHaveBeenCalled();
  });

  it('lists agents with how each asks, and opens one to edit or a new one', async () => {
    mockApi.listAgents.mockResolvedValue([agent(4, 'Reviewer', { title: 'Reviews pull requests', pinned: true }), agent(5, 'Editor', { approval_mode: 'accept_edits', archived_at: '2026-11-01T00:00:00Z' })]);
    await render(<Agents />);
    expect(await screen.findByText('Reviewer')).toBeTruthy();
    expect(screen.getByText('Ask first · Pinned')).toBeTruthy();
    expect(screen.getByText('Accept edits · Archived')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Edit Reviewer'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/agents/[id]', params: { id: '4' } });
    await fireEvent.press(screen.getByText('New agent'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/agents/[id]', params: { id: 'new' } });
  });

  it('explains an empty list as the web does', async () => {
    await render(<Agents />);
    expect(await screen.findByText(/No agents yet\. An agent keeps its own instructions/)).toBeTruthy();
  });

  it('asks for archived agents too when the switch is turned on', async () => {
    await render(<Agents />);
    await waitFor(() => expect(mockApi.listAgents).toHaveBeenCalledWith(false));
    await fireEvent.press(screen.getByLabelText('Show archived'));
    await waitFor(() => expect(mockApi.listAgents).toHaveBeenCalledWith(true));
  });

  it('duplicates, pins and archives from the menu, then reads the list again', async () => {
    mockApi.listAgents.mockResolvedValue([agent(4, 'Reviewer')]);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<Agents />);
    await fireEvent.press(await screen.findByLabelText('More actions for Reviewer'));
    const buttons = alert.mock.calls[0][2]!;
    const press = async (text: string) => buttons.find((button) => button.text === text)!.onPress!();

    await press('Duplicate');
    expect(mockApi.duplicateAgent).toHaveBeenCalledWith(4);
    await press('Pin to top');
    expect(mockApi.updateAgent).toHaveBeenCalledWith(4, { pinned: true });
    await press('Archive');
    expect(mockApi.updateAgent).toHaveBeenCalledWith(4, { archived: true });
    expect(buttons.map((button) => button.text)).not.toContain('Delete');
    alert.mockRestore();
  });

  it('shows why an action failed', async () => {
    mockApi.listAgents.mockResolvedValue([agent(4, 'Reviewer')]);
    mockApi.duplicateAgent.mockRejectedValue(new ApiError(403, 'scope_denied', ''));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<Agents />);
    await fireEvent.press(await screen.findByLabelText('More actions for Reviewer'));
    await alert.mock.calls[0][2]!.find((button) => button.text === 'Duplicate')!.onPress!();
    expect(await screen.findByText(/Chat, files and agents/)).toBeTruthy();
    alert.mockRestore();
  });
});

describe('Agent editor, creating', () => {
  it('needs a name before it saves, then creates an agent that asks first', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Name');
    await fireEvent.press(screen.getByLabelText('Create agent'));
    expect(await screen.findByText('Give the agent a name.')).toBeTruthy();
    expect(mockApi.createAgent).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('Name'), ' Ada ');
    await fireEvent.changeText(screen.getByLabelText('Instructions'), 'Be brief.');
    await fireEvent.press(screen.getByLabelText('Create agent'));
    await waitFor(() => expect(mockApi.createAgent).toHaveBeenCalledTimes(1));
    expect(mockApi.createAgent.mock.calls[0][0]).toEqual({
      name: 'Ada',
      instructions: 'Be brief.',
      provider: 'claude',
      model: null,
      approval_mode: 'ask',
      memory_enabled: true,
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it('never offers Accept edits, the workspace folder or connected apps', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Name');
    expect(screen.getByLabelText('Accept edits').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/workspace folder, connected apps, skills, notes, computer and team lead role are set in the web app/)).toBeTruthy();
    expect(screen.queryByLabelText('Workspace folder')).toBeNull();
  });

  it('chooses Plan only and sends it', async () => {
    await render(<AgentEditor />);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Ada');
    await fireEvent.press(screen.getByLabelText('Plan only'));
    await fireEvent.press(screen.getByLabelText('Create agent'));
    await waitFor(() => expect(mockApi.createAgent).toHaveBeenCalled());
    expect(mockApi.createAgent.mock.calls[0][0]).toMatchObject({ approval_mode: 'plan' });
  });

  it('puts a name that is already used on the name field and keeps the form', async () => {
    mockApi.createAgent.mockRejectedValue(new ApiError(409, 'agent_name_taken', ''));
    await render(<AgentEditor />);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Ada');
    await fireEvent.press(screen.getByLabelText('Create agent'));
    expect(await screen.findByText(/already have an agent with this name/)).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    // Typing another name clears it.
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Ada 2');
    expect(screen.queryByText(/already have an agent with this name/)).toBeNull();
  });

  it('shows what the server refused in words', async () => {
    mockApi.createAgent.mockRejectedValue(new ApiError(403, 'field_requires_admin', ''));
    await render(<AgentEditor />);
    await fireEvent.changeText(await screen.findByLabelText('Name'), 'Ada');
    await fireEvent.press(screen.getByLabelText('Create agent'));
    expect(await screen.findByText(/can only be changed in the web app/)).toBeTruthy();
  });

  it('lists engines, marking one that is not ready, and moves the model with the engine', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Name');
    await fireEvent.press(screen.getByLabelText('Engine, Claude Code'));
    expect(screen.getByLabelText('Gemini').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Not signed in')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Codex'));
    expect(screen.getByLabelText('Engine, Codex')).toBeTruthy();
    expect(screen.getByLabelText('Model, Engine default (GPT X)')).toBeTruthy();
  });

  it('does not let the fallback engine be the agent’s own', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Name');
    await fireEvent.press(screen.getByLabelText('Fallback engine, None'));
    expect(screen.queryByLabelText('Claude Code')).toBeNull();
    expect(screen.getByLabelText('Codex')).toBeTruthy();
  });

  it('asks before leaving with changes, and not before leaving an untouched form', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Name');
    expect(mockPrevent.active).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Ada');
    expect(mockPrevent.active).toBe(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const repeat = jest.fn();
    mockPrevent.callback!({ repeat });
    expect(alert.mock.calls[0][0]).toBe('Discard unsaved changes?');
    alert.mock.calls[0][2]!.find((button) => button.text === 'Discard changes')!.onPress!();
    expect(repeat).toHaveBeenCalled();
    alert.mockRestore();
  });

  it('refuses a phone that was not paired to manage agents', async () => {
    mockScopes = ['chat'];
    await render(<AgentEditor />);
    expect(screen.getByText(/Chat, files and agents/)).toBeTruthy();
    expect(mockApi.listEngines).not.toHaveBeenCalled();
  });
});

describe('Agent editor, editing', () => {
  beforeEach(() => {
    mockParams = { id: '4' };
    mockApi.getAgent.mockResolvedValue(agent(4, 'Reviewer', { title: 'Reviews', instructions: 'Old.', approval_mode: 'accept_edits', workspace_path: '/home/me/project' }));
  });

  it('loads the agent and saves only what changed, so the workspace folder is never sent', async () => {
    await render(<AgentEditor />);
    expect((await screen.findByLabelText('Instructions')).props.value).toBe('Old.');
    // Nothing changed yet: nothing to save.
    expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Instructions'), 'New.');
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(mockApi.updateAgent).toHaveBeenCalledWith(4, { instructions: 'New.' }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('lets an agent on Accept edits be moved to Ask first', async () => {
    await render(<AgentEditor />);
    await screen.findByLabelText('Instructions');
    expect(screen.getByLabelText('Accept edits').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByLabelText('Ask first'));
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(mockApi.updateAgent).toHaveBeenCalledWith(4, { approval_mode: 'ask' }));
  });

  it('says what saving changes for conversations already started', async () => {
    await render(<AgentEditor />);
    expect(await screen.findByText('When you save')).toBeTruthy();
    expect(screen.getByText(/keeps the engine it started on/)).toBeTruthy();
    expect(screen.getByText(/reach only conversations started after the change/)).toBeTruthy();
  });

  it('shows why the agent could not be read', async () => {
    mockApi.getAgent.mockRejectedValue(new ApiError(404, null, ''));
    await render(<AgentEditor />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('does not ask to discard after a save', async () => {
    await render(<AgentEditor />);
    await fireEvent.changeText(await screen.findByLabelText('Title'), 'Reviews code');
    expect(mockPrevent.active).toBe(true);
    await fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });
});

describe('Settings', () => {
  it('shows no Agents row to a chat-only phone, and says what access it has', async () => {
    mockScopes = ['chat'];
    await render(<Settings />);
    expect(screen.getByText('Chat only')).toBeTruthy();
    expect(screen.queryByText('Agents')).toBeNull();
  });

  it('offers Agents to a phone paired to manage them', async () => {
    mockScopes = ['chat', 'files', 'manage'];
    await render(<Settings />);
    expect(screen.getByText('Chat, files and agents')).toBeTruthy();
    await fireEvent.press(screen.getByText('Agents'));
    expect(mockPush).toHaveBeenCalledWith('/agents');
  });
});

describe('form controls', () => {
  const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, number | undefined>;
  const tall = (node: { props: { style?: unknown } }) => Math.max(flat(node).height ?? 0, flat(node).minHeight ?? 0);

  it('are at least 44 points tall', async () => {
    await render(
      <>
        <Button label="Go" onPress={jest.fn()} />
        <SwitchRow label="Use notes" value onValueChange={jest.fn()} />
        <RadioGroup label="Mode" options={[{ value: 'a', label: 'Alpha' }]} value="a" onChange={jest.fn()} />
        <PickerField label="Engine" title="Engine" valueLabel="Claude" options={[{ value: 'a', label: 'A' }]} value="a" onChange={jest.fn()} />
      </>,
    );
    for (const label of ['Go', 'Use notes', 'Alpha', 'Engine, Claude']) expect(tall(screen.getByLabelText(label))).toBeGreaterThanOrEqual(touch.min);
  });

  it('does nothing while busy and reports itself busy', async () => {
    const onPress = jest.fn();
    await render(<Button label="Save" onPress={onPress} busy />);
    expect(screen.getByLabelText('Save').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });
});
