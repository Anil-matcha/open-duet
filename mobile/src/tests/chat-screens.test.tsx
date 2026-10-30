import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FlatList } from 'react-native';

import Conversations from '../app';
import Thread from '../app/thread/[id]';
import { Composer } from '@/components/composer';
import { emptyTranscript } from '@/lib/transcript';

const mockPush = jest.fn();
let mockThreadState: Record<string, unknown> = {};
let mockParams: Record<string, string> = { id: '3' };
const mockApi = { listThreads: jest.fn(), createThread: jest.fn(), listAgents: jest.fn() };

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => ({ push: mockPush }),
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
  };
});

jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));
jest.mock('@/lib/use-thread', () => ({ useThread: () => mockThreadState }));

const thread = (id: number, title: string | null) => ({
  id,
  title,
  provider: 'claude',
  model: null,
  session_state: 'active',
  last_seq: 0,
  archived_at: null,
  created_at: '2026-10-27T10:00:00Z',
  updated_at: new Date().toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { id: '3' };
  mockApi.listAgents.mockResolvedValue([]);
  mockThreadState = {
    transcript: emptyTranscript(),
    thread: thread(3, 'Plan the week'),
    connection: 'live',
    error: null,
    loaded: true,
    running: false,
    send: jest.fn().mockResolvedValue(true),
    stop: jest.fn().mockResolvedValue(undefined),
    answerApproval: jest.fn().mockResolvedValue(true),
  };
});

describe('Conversations', () => {
  it('lists the conversations and opens one', async () => {
    mockApi.listThreads.mockResolvedValue([thread(3, 'Plan the week'), thread(4, null)]);
    await render(<Conversations />);
    await fireEvent.press(await screen.findByText('Plan the week'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/thread/[id]', params: { id: '3' } });
    // A conversation with no title is listed as "New conversation" too.
    expect(screen.getAllByText('New conversation')).toHaveLength(2);
  });

  it('opens the search', async () => {
    mockApi.listThreads.mockResolvedValue([]);
    await render(<Conversations />);
    await fireEvent.press(screen.getByLabelText('Search conversations'));
    expect(mockPush).toHaveBeenCalledWith('/search');
  });

  it('says so when there are none', async () => {
    mockApi.listThreads.mockResolvedValue([]);
    await render(<Conversations />);
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
  });

  it('shows why the list could not load', async () => {
    const { ApiError } = jest.requireActual('@/lib/api');
    mockApi.listThreads.mockRejectedValue(new ApiError(0, 'unreachable', ''));
    await render(<Conversations />);
    expect(await screen.findByText(/could not reach your server/i)).toBeTruthy();
  });

  it('starts a conversation and opens it', async () => {
    mockApi.listThreads.mockResolvedValue([]);
    mockApi.createThread.mockResolvedValue(thread(9, null));
    await render(<Conversations />);
    await fireEvent.press(await screen.findByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: '/thread/[id]', params: { id: '9' } }));
  });
});

describe('Thread', () => {
  const longConversation = () => ({
    ...emptyTranscript(),
    items: Array.from({ length: 12 }, (_, n) => ({ kind: 'assistant' as const, key: `e${n + 1}`, turnId: 1, text: `message ${n + 1}`, incomplete: false })),
  });

  const scrolled = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 300, height: 3000 }, layoutMeasurement: { width: 300, height: 600 } } });

  it('offers a jump to the latest message only while scrolled up from it, and goes there', async () => {
    const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => undefined);
    mockThreadState = { ...mockThreadState, transcript: longConversation() };
    await render(<Thread />);
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();

    await fireEvent.scroll(screen.getByTestId('conversation-list'), scrolled(0));
    await fireEvent.press(screen.getByLabelText('Jump to latest'));
    expect(toEnd).toHaveBeenLastCalledWith({ animated: true });
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();

    // Back near the end, the button stays away.
    await fireEvent.scroll(screen.getByTestId('conversation-list'), scrolled(2380));
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();
    toEnd.mockRestore();
  });

  it('opens at the message a search found instead of the end', async () => {
    const toIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => undefined);
    mockParams = { id: '3', seq: '5' };
    mockThreadState = { ...mockThreadState, transcript: longConversation() };
    await render(<Thread />);
    await waitFor(() => expect(toIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 4, animated: false })));
    expect(toIndex).toHaveBeenCalledTimes(1);
    expect(toEnd).not.toHaveBeenCalled();
    toIndex.mockRestore();
    toEnd.mockRestore();
  });

  it('goes to the end, as usual, for a message that is not in the transcript', async () => {
    const toIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const toEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => undefined);
    mockParams = { id: '3', seq: '99' };
    mockThreadState = { ...mockThreadState, transcript: longConversation() };
    await render(<Thread />);
    await waitFor(() => expect(toEnd).toHaveBeenCalled());
    expect(toIndex).not.toHaveBeenCalled();
    toIndex.mockRestore();
    toEnd.mockRestore();
  });

  it('does not jump anywhere when it was not opened from a search', async () => {
    const toIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    mockThreadState = { ...mockThreadState, transcript: longConversation() };
    await render(<Thread />);
    expect(toIndex).not.toHaveBeenCalled();
    toIndex.mockRestore();
  });

  it('shows the conversation, the typing preview and a reconnect banner', async () => {
    mockThreadState = {
      ...mockThreadState,
      connection: 'reconnecting',
      transcript: {
        ...emptyTranscript(),
        items: [
          { kind: 'user', key: 'e1', turnId: 1, text: 'hello there', attachments: [] },
          { kind: 'assistant', key: 'e2', turnId: 1, text: 'hi, how can I help?', incomplete: false },
          { kind: 'tool', key: 'e3', turnId: 1, callId: 'c', name: 'Bash', summary: 'ls -la', state: 'running' },
          { kind: 'approval', key: 'e4', turnId: 1, approvalId: 'a', tool: 'Bash', approvalKind: 'command', summary: 'rm -rf build', input: { command: 'rm -rf build' }, status: 'pending' },
          { kind: 'unsupported', key: 'e5', type: 'something.new' },
        ],
        typing: 'Working on it',
      },
    };
    await render(<Thread />);
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('hi, how can I help?')).toBeTruthy();
    expect(screen.getByText(/ls -la/)).toBeTruthy();
    expect(screen.getByText('Waiting for your approval')).toBeTruthy();
    expect(screen.getByText(/cannot show \(something\.new\)/)).toBeTruthy();
    expect(screen.getByText('Working on it')).toBeTruthy();
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });

  it('pins the oldest waiting approval above the composer and answers it', async () => {
    const approval = (id: string, summary: string) => ({ kind: 'approval', key: id, turnId: 1, approvalId: id, tool: 'Bash', approvalKind: 'command', summary, input: { command: summary }, status: 'pending' });
    mockThreadState = { ...mockThreadState, running: true, transcript: { ...emptyTranscript(), items: [approval('a1', 'first command'), approval('a2', 'second command')] } };
    await render(<Thread />);
    expect(screen.getByLabelText('Approval needed')).toBeTruthy();
    expect(screen.getByText(/1 of 2 waiting/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Allow' }));
    expect(mockThreadState.answerApproval).toHaveBeenCalledWith('a1', 'allow');
  });

  it('shows no approval card when nothing is waiting', async () => {
    mockThreadState = {
      ...mockThreadState,
      transcript: { ...emptyTranscript(), items: [{ kind: 'approval', key: 'a', turnId: 1, approvalId: 'a', tool: 'Bash', approvalKind: 'command', summary: 'done', input: {}, status: 'allowed' }] },
    };
    await render(<Thread />);
    expect(screen.queryByLabelText('Approval needed')).toBeNull();
  });

  it('invites the first message in an empty conversation', async () => {
    await render(<Thread />);
    expect(screen.getByText('Say something to start.')).toBeTruthy();
  });

  it('shows an error from sending', async () => {
    mockThreadState = { ...mockThreadState, error: 'An answer is already running. Wait for it, or stop it.' };
    await render(<Thread />);
    expect(screen.getByText(/already running/)).toBeTruthy();
  });
});

describe('Composer', () => {
  it('sends the trimmed message and clears the box once it was accepted', async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), '  hello  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('hello', []);
    await waitFor(() => expect(screen.getByLabelText('Message').props.value).toBe(''));
  });

  it('keeps what was typed when sending failed', async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'keep me');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(screen.getByLabelText('Message').props.value).toBe('keep me');
  });

  it('does not send a blank message', async () => {
    const onSend = jest.fn();
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers Stop, not Send, while an answer is running', async () => {
    const onStop = jest.fn().mockResolvedValue(undefined);
    await render(<Composer running onSend={jest.fn()} onStop={onStop} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });
});
