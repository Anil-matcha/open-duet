import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import Conversations from '../app';
import Thread from '../app/thread/[id]';
import { Composer } from '@/components/composer';
import { emptyTranscript } from '@/lib/transcript';

const mockPush = jest.fn();
let mockThreadState: Record<string, unknown> = {};
const mockApi = { listThreads: jest.fn(), createThread: jest.fn() };

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => ({ push: mockPush }),
    useLocalSearchParams: () => ({ id: '3' }),
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
  mockThreadState = {
    transcript: emptyTranscript(),
    thread: thread(3, 'Plan the week'),
    connection: 'live',
    error: null,
    loaded: true,
    running: false,
    send: jest.fn().mockResolvedValue(true),
    stop: jest.fn().mockResolvedValue(undefined),
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
  it('shows the conversation, the typing preview and a reconnect banner', async () => {
    mockThreadState = {
      ...mockThreadState,
      connection: 'reconnecting',
      transcript: {
        ...emptyTranscript(),
        items: [
          { kind: 'user', key: 'e1', turnId: 1, text: 'hello there' },
          { kind: 'assistant', key: 'e2', turnId: 1, text: 'hi, how can I help?', incomplete: false },
          { kind: 'tool', key: 'e3', turnId: 1, callId: 'c', name: 'Bash', summary: 'ls -la', state: 'running' },
          { kind: 'approval', key: 'e4', turnId: 1, approvalId: 'a', tool: 'Bash', summary: 'rm -rf build', status: 'pending' },
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
    expect(onSend).toHaveBeenCalledWith('hello');
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
