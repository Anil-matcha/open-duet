import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import Conversations from '../app';
import NewConversation from '../app/new';
import { agentName, agentSummary, approvalModeLabel, type Agent } from '@/lib/agents';
import { ApiError, createApi, describeApiError } from '@/lib/api';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockApi = { listThreads: jest.fn(), createThread: jest.fn(), listAgents: jest.fn() };

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
  };
});
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
  ...extra,
});

const thread = (id: number, agentId: number | null) => ({
  id,
  title: `Thread ${id}`,
  provider: 'claude',
  model: null,
  session_state: 'active',
  agent_id: agentId,
  last_seq: 0,
  archived_at: null,
  created_at: '2026-10-27T10:00:00Z',
  updated_at: new Date().toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.listThreads.mockResolvedValue([]);
  mockApi.listAgents.mockResolvedValue([]);
});

describe('agent helpers', () => {
  it('says how an agent asks before it acts, and passes unknown modes through', () => {
    expect(approvalModeLabel('ask')).toBe('Asks before acting');
    expect(approvalModeLabel('accept_edits')).toBe('Accepts file edits');
    expect(approvalModeLabel('plan')).toBe('Plans only');
    expect(approvalModeLabel('newer_mode')).toBe('newer_mode');
  });

  it('summarises with the title, else the description, else the engine', () => {
    expect(agentSummary(agent(1, 'a', { title: 'Researcher', description: 'long' }))).toBe('Researcher');
    expect(agentSummary(agent(1, 'a', { description: 'Finds things' }))).toBe('Finds things');
    expect(agentSummary(agent(1, 'a', { title: '  ', model: 'haiku' }))).toBe('claude · haiku');
  });

  it('finds the name of the agent a conversation came from, or nothing', () => {
    const agents = [agent(1, 'Researcher')];
    expect(agentName(agents, 1)).toBe('Researcher');
    expect(agentName(agents, 9)).toBeNull();
    expect(agentName(agents, null)).toBeNull();
    expect(agentName(agents, undefined)).toBeNull();
  });
});

describe('api', () => {
  const session = { server: 'https://dots.example.com', token: 'ods_t' };
  const calls: { url: string; body?: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body as string | undefined });
    return { status: 200, ok: true, json: async () => [] } as unknown as Response;
  }) as unknown as typeof fetch;
  beforeEach(() => {
    calls.length = 0;
  });

  it('starts a conversation from an agent only when one is chosen', async () => {
    const api = createApi(session, { fetchImpl: impl });
    await api.createThread();
    await api.createThread(5);
    expect(JSON.parse(calls[0].body!)).toEqual({});
    expect(JSON.parse(calls[1].body!)).toEqual({ agent_id: 5 });
  });

  it('lists agents', async () => {
    await createApi(session, { fetchImpl: impl }).listAgents();
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/agents');
  });

  it('does not call a refused request a file problem', () => {
    expect(describeApiError(new ApiError(422, null, ''))).toBe('Your server did not accept that request.');
  });
});

describe('Conversations with agents', () => {
  it('starts straight away when there are no agents', async () => {
    mockApi.createThread.mockResolvedValue(thread(9, null));
    await render(<Conversations />);
    await fireEvent.press(await screen.findByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(mockApi.createThread).toHaveBeenCalledWith());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/thread/[id]', params: { id: '9' } });
  });

  it('opens the picker when there are agents', async () => {
    mockApi.listAgents.mockResolvedValue([agent(1, 'Researcher')]);
    await render(<Conversations />);
    // The empty list shows once both the conversations and the agents have been read.
    await screen.findByText('No conversations yet.');
    await fireEvent.press(screen.getByRole('button', { name: 'New conversation' }));
    expect(mockPush).toHaveBeenCalledWith('/new');
    expect(mockApi.createThread).not.toHaveBeenCalled();
  });

  it('names the agent a conversation came from, else the engine', async () => {
    mockApi.listAgents.mockResolvedValue([agent(1, 'Researcher')]);
    mockApi.listThreads.mockResolvedValue([thread(1, 1), thread(2, null), thread(3, 99)]);
    await render(<Conversations />);
    expect(await screen.findByText(/^Researcher/)).toBeTruthy();
    expect(screen.getAllByText(/^claude/)).toHaveLength(2);
  });

  it('still lists conversations when the agents cannot be read', async () => {
    mockApi.listAgents.mockRejectedValue(new ApiError(404, null, ''));
    mockApi.listThreads.mockResolvedValue([thread(1, null)]);
    await render(<Conversations />);
    expect(await screen.findByText('Thread 1')).toBeTruthy();
  });
});

describe('NewConversation', () => {
  it('offers the default and each agent, with how each asks before acting', async () => {
    mockApi.listAgents.mockResolvedValue([agent(1, 'Researcher', { title: 'Finds things' }), agent(2, 'Editor', { approval_mode: 'accept_edits' })]);
    await render(<NewConversation />);
    expect(await screen.findByText('Default assistant')).toBeTruthy();
    expect(screen.getByText('Researcher')).toBeTruthy();
    expect(screen.getByText('Finds things')).toBeTruthy();
    expect(screen.getByText('Accepts file edits')).toBeTruthy();
  });

  it('starts a conversation from the chosen agent and opens it in place of the picker', async () => {
    mockApi.listAgents.mockResolvedValue([agent(7, 'Researcher')]);
    mockApi.createThread.mockResolvedValue(thread(12, 7));
    await render(<NewConversation />);
    await fireEvent.press(await screen.findByText('Researcher'));
    await waitFor(() => expect(mockApi.createThread).toHaveBeenCalledWith(7));
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/thread/[id]', params: { id: '12' } });
  });

  it('starts with the server default when no agent is chosen', async () => {
    mockApi.listAgents.mockResolvedValue([agent(7, 'Researcher')]);
    mockApi.createThread.mockResolvedValue(thread(13, null));
    await render(<NewConversation />);
    await fireEvent.press(await screen.findByText('Default assistant'));
    await waitFor(() => expect(mockApi.createThread).toHaveBeenCalledWith(undefined));
    expect(mockReplace).toHaveBeenCalled();
  });

  it('shows why it failed and lets you choose again', async () => {
    mockApi.listAgents.mockResolvedValue([agent(7, 'Researcher')]);
    mockApi.createThread.mockRejectedValue(new ApiError(0, 'unreachable', ''));
    await render(<NewConversation />);
    await fireEvent.press(await screen.findByText('Researcher'));
    expect(await screen.findByText(/could not reach your server/i)).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    mockApi.createThread.mockResolvedValue(thread(14, 7));
    await fireEvent.press(screen.getByText('Researcher'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  });

  it('shows the error and still offers the default when the agents cannot be read', async () => {
    mockApi.listAgents.mockRejectedValue(new ApiError(0, 'unreachable', ''));
    await render(<NewConversation />);
    expect(await screen.findByText(/could not reach your server/i)).toBeTruthy();
    expect(screen.getByText('Default assistant')).toBeTruthy();
  });
});
