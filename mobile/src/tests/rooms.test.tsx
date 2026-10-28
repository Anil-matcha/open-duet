import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';

import RoomsList from '../app/rooms';
import RoomScreen from '../app/rooms/[id]';
import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { RoomMessage } from '@/components/room-message';
import { ApiError, createApi } from '@/lib/api';
import { applyRoomEvents, emptyFeed, loadRoomApprovals, mentionNames, roomBusy, workingNames, type Room } from '@/lib/rooms';
import { useRoom } from '@/lib/use-room';

const room = (extra: Partial<Room> = {}): Room => ({
  id: 3,
  name: 'Launch',
  thread_id: 40,
  last_seq: 0,
  last_read_seq: 0,
  unread: false,
  default_responder_kind: 'mentions',
  members: [
    { agent_id: 1, name: 'Researcher', held: false, member_thread_id: 41 },
    { agent_id: 2, name: 'Editor', held: true, member_thread_id: 42 },
  ],
  dispatches: [],
  ...extra,
});

const message = (seq: number, label: string, kind: 'person' | 'agent', text: string) => ({ seq, type: 'room.message', data: { author: { kind, label }, text } });

describe('applyRoomEvents', () => {
  it('turns messages and notices into rows and skips the rest', () => {
    const feed = applyRoomEvents(emptyFeed(), [
      message(1, 'You', 'person', 'hi'),
      { seq: 2, type: 'room.member.state', data: { agent_id: 1, state: 'done' } },
      message(3, 'Researcher', 'agent', 'hello'),
      { seq: 4, type: 'room.notice', data: { text: 'Member held.' } },
    ]);
    expect(feed.items).toEqual([
      { kind: 'message', key: 'm1', seq: 1, author: 'You', mine: true, text: 'hi' },
      { kind: 'message', key: 'm3', seq: 3, author: 'Researcher', mine: false, text: 'hello' },
      { kind: 'notice', key: 'n4', seq: 4, text: 'Member held.' },
    ]);
    // Events that are not drawn still count as seen, so a reconnect resumes after them.
    expect(feed.lastSeq).toBe(4);
  });

  it('applies a stored event once, however often it is replayed', () => {
    const once = applyRoomEvents(emptyFeed(), [message(1, 'You', 'person', 'hi')]);
    const again = applyRoomEvents(once, [message(1, 'You', 'person', 'hi'), message(2, 'Editor', 'agent', 'ok')]);
    expect(again.items).toHaveLength(2);
  });

  it('copes with a message with no author', () => {
    const feed = applyRoomEvents(emptyFeed(), [{ seq: 1, type: 'room.message', data: { text: 'x' } }]);
    expect(feed.items[0]).toMatchObject({ author: 'Agent', mine: false });
  });
});

describe('room helpers', () => {
  it('knows when agents are working, and who', () => {
    const busy = room({ dispatches: [{ id: 1, agent_id: 1, message_seq: 1, status: 'running', reason: 'mention' }, { id: 2, agent_id: 2, message_seq: 1, status: 'done', reason: 'mention' }] });
    expect(roomBusy(busy)).toBe(true);
    expect(workingNames(busy)).toEqual(['Researcher']);
    expect(roomBusy(room())).toBe(false);
    expect(roomBusy(null)).toBe(false);
  });

  it('offers to tag members that would answer, and everyone', () => {
    expect(mentionNames(room())).toEqual(['Researcher', 'everyone']);
    expect(mentionNames(null)).toEqual([]);
  });
});

describe('loadRoomApprovals', () => {
  const row = (id: string, status = 'pending') => ({ id, turn_id: 9, tool: 'Bash', input: { command: 'ls' }, summary: 'ls', kind: 'command', status });

  it('asks no member when nothing is waiting', async () => {
    const api = { listRoomApprovals: jest.fn().mockResolvedValue([]), listThreadApprovals: jest.fn() };
    expect(await loadRoomApprovals(api, room())).toEqual([]);
    expect(api.listThreadApprovals).not.toHaveBeenCalled();
  });

  it('finds the thread each waiting request belongs to', async () => {
    const api = {
      listRoomApprovals: jest.fn().mockResolvedValue([row('a1')]),
      listThreadApprovals: jest.fn(async (id: number) => (id === 42 ? [row('a1')] : [row('other')])),
    };
    const found = await loadRoomApprovals(api, room());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ approvalId: 'a1', threadId: 42, agentName: 'Editor', tool: 'Bash', input: { command: 'ls' } });
  });

  it('skips a member that cannot be read, and ones that are no longer pending', async () => {
    const api = {
      listRoomApprovals: jest.fn().mockResolvedValue([row('a1'), row('a2')]),
      listThreadApprovals: jest.fn(async (id: number) => {
        if (id === 41) throw new ApiError(404, null, '');
        return [row('a1', 'allowed'), row('a2')];
      }),
    };
    const found = await loadRoomApprovals(api, room());
    expect(found.map((item) => item.approvalId)).toEqual(['a2']);
  });
});

describe('api', () => {
  it('uses the room routes a chat device may reach', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url: url.replace('https://s.example', ''), method: init.method, body: init.body as string | undefined });
      return { status: 200, ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = createApi({ server: 'https://s.example', token: 't' }, { fetchImpl: impl });
    await api.listRooms();
    await api.getRoom(3);
    await api.postRoomMessage(3, 'hi');
    await api.stopRoom(3);
    await api.markRoomRead(3, 7);
    await api.listRoomApprovals(3);
    await api.listThreadApprovals(41);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/v1/rooms',
      'GET /api/v1/rooms/3',
      'POST /api/v1/rooms/3/messages',
      'POST /api/v1/rooms/3/stop',
      'POST /api/v1/rooms/3/read',
      'GET /api/v1/rooms/3/approvals',
      'GET /api/v1/threads/41/approvals?status=pending',
    ]);
    expect(JSON.parse(calls[2].body!)).toEqual({ text: 'hi' });
    expect(JSON.parse(calls[4].body!)).toEqual({ seq: 7 });
  });
});

// ---- the hook, with a fake server and a fake stream
const mockApi = {
  getRoom: jest.fn(),
  listRoomApprovals: jest.fn(),
  listThreadApprovals: jest.fn(),
  postRoomMessage: jest.fn(),
  stopRoom: jest.fn(),
  markRoomRead: jest.fn(),
  answerApproval: jest.fn(),
  listRooms: jest.fn(),
};
let streamOptions: { threadId: number; onEvents: (events: unknown[]) => void; after: number } | null = null;

jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));
jest.mock('@/lib/auth-context', () => ({ useAuth: () => ({ state: { status: 'paired', server: 'https://s.example', token: 't' }, revoked: jest.fn() }) }));
jest.mock('@/lib/sse', () => ({
  followThread: jest.fn(async (options: never) => {
    streamOptions = options;
  }),
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => ({ push: mockPush }),
    useLocalSearchParams: () => ({ id: '3' }),
    useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
  };
});
const mockPush = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  streamOptions = null;
  mockApi.getRoom.mockResolvedValue(room({ last_seq: 2 }));
  mockApi.listRoomApprovals.mockResolvedValue([]);
  mockApi.listThreadApprovals.mockResolvedValue([]);
  mockApi.postRoomMessage.mockResolvedValue({ seq: 3 });
  mockApi.stopRoom.mockResolvedValue({});
  mockApi.markRoomRead.mockResolvedValue({ seq: 2 });
  mockApi.answerApproval.mockResolvedValue({ status: 'ok', decision: 'allow' });
  mockApi.listRooms.mockResolvedValue([]);
});

describe('useRoom', () => {
  it('loads the room, follows its thread, and shows messages as they arrive', async () => {
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.room?.name).toBe('Launch'));
    await waitFor(() => expect(streamOptions?.threadId).toBe(40));
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      streamOptions!.onEvents([message(1, 'You', 'person', 'hi'), message(2, 'Researcher', 'agent', 'hello')]);
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.loaded).toBe(true);
    await waitFor(() => expect(mockApi.markRoomRead).toHaveBeenCalledWith(3, 2));
  });

  it('posts a message and reports success or the reason it failed', async () => {
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.room).not.toBeNull());
    let ok = false;
    await act(async () => {
      ok = await result.current.send('@Researcher look');
    });
    expect(ok).toBe(true);
    expect(mockApi.postRoomMessage).toHaveBeenCalledWith(3, '@Researcher look');

    mockApi.postRoomMessage.mockRejectedValue(new ApiError(0, 'unreachable', ''));
    await act(async () => {
      ok = await result.current.send('again');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/could not reach your server/i);
  });

  it('shows a waiting request and answers it on the agent’s own thread', async () => {
    mockApi.listRoomApprovals.mockResolvedValue([{ id: 'a1' }]);
    mockApi.listThreadApprovals.mockImplementation(async (id: number) => (id === 41 ? [{ id: 'a1', tool: 'Bash', input: { command: 'ls' }, status: 'pending' }] : []));
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    await act(async () => {
      await result.current.answer(result.current.approvals[0], 'allow');
    });
    expect(mockApi.answerApproval).toHaveBeenCalledWith(41, 'a1', 'allow');
  });

  it('reads the room again after an answer that was too late', async () => {
    mockApi.listRoomApprovals.mockResolvedValue([{ id: 'a1' }]);
    mockApi.listThreadApprovals.mockImplementation(async (id: number) => (id === 41 ? [{ id: 'a1', tool: 'Bash', input: {}, status: 'pending' }] : []));
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    mockApi.answerApproval.mockRejectedValue(new ApiError(409, 'approval_not_waiting', ''));
    mockApi.listRoomApprovals.mockResolvedValue([]);
    let ok = true;
    await act(async () => {
      ok = await result.current.answer(result.current.approvals[0], 'deny');
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(/no longer waiting/i);
    await waitFor(() => expect(result.current.approvals).toHaveLength(0));
  });

  it('stops the agents', async () => {
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.room).not.toBeNull());
    await act(async () => {
      await result.current.stop();
    });
    expect(mockApi.stopRoom).toHaveBeenCalledWith(3);
  });

  it('says why the room could not be read', async () => {
    mockApi.getRoom.mockRejectedValue(new ApiError(404, null, 'Room not found'));
    const { result } = await renderHook(() => useRoom(3));
    await waitFor(() => expect(result.current.error).toBe('That room no longer exists.'));
  });
});

// ---- screens
describe('Rooms list', () => {
  it('lists rooms with who is in them, unread marks, and opens one', async () => {
    mockApi.listRooms.mockResolvedValue([
      room({ unread: true }),
      room({ id: 4, name: 'Quiet', members: [{ agent_id: 1, name: 'Researcher', held: false, member_thread_id: 41 }], dispatches: [{ id: 1, agent_id: 1, message_seq: 1, status: 'running', reason: 'mention' }] }),
    ]);
    await render(<RoomsList />);
    expect(await screen.findByText('Launch')).toBeTruthy();
    expect(screen.getByLabelText('Unread messages')).toBeTruthy();
    expect(screen.getByText(/Researcher working · Researcher/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Launch'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/rooms/[id]', params: { id: '3' } });
  });

  it('says rooms are made in the web app when there are none', async () => {
    await render(<RoomsList />);
    expect(await screen.findByText(/Rooms are made in the web app/)).toBeTruthy();
  });

  it('shows why the list could not load', async () => {
    mockApi.listRooms.mockRejectedValue(new ApiError(0, 'unreachable', ''));
    await render(<RoomsList />);
    expect(await screen.findByText(/could not reach your server/i)).toBeTruthy();
  });
});

describe('Room screen', () => {
  it('shows messages by who wrote them, who is working, and stops them', async () => {
    mockApi.getRoom.mockResolvedValue(room({ last_seq: 2, dispatches: [{ id: 1, agent_id: 1, message_seq: 1, status: 'running', reason: 'mention' }] }));
    await render(<RoomScreen />);
    await waitFor(() => expect(streamOptions).not.toBeNull());
    await act(async () => {
      streamOptions!.onEvents([message(1, 'You', 'person', 'hi'), message(2, 'Researcher', 'agent', '**done**')]);
    });
    expect(await screen.findByText('hi')).toBeTruthy();
    expect(screen.getAllByText('Researcher').length).toBeGreaterThan(0);
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('Researcher working…')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Stop'));
    await waitFor(() => expect(mockApi.stopRoom).toHaveBeenCalledWith(3));
  });

  it('adds a tag to the message and posts it', async () => {
    await render(<RoomScreen />);
    await waitFor(() => expect(streamOptions).not.toBeNull());
    await act(async () => {
      streamOptions!.onEvents([message(1, 'You', 'person', 'hi'), message(2, 'You', 'person', 'again')]);
    });
    await screen.findByText('again');
    await fireEvent.press(screen.getByLabelText('Mention Researcher'));
    expect(screen.getByLabelText('Message').props.value).toBe('@Researcher ');
    await fireEvent.changeText(screen.getByLabelText('Message'), '@Researcher look');
    await fireEvent.press(screen.getByLabelText('Send'));
    await waitFor(() => expect(mockApi.postRoomMessage).toHaveBeenCalledWith(3, '@Researcher look'));
  });

  it('pins a waiting request, naming the agent that asks', async () => {
    mockApi.listRoomApprovals.mockResolvedValue([{ id: 'a1' }]);
    mockApi.listThreadApprovals.mockImplementation(async (id: number) => (id === 41 ? [{ id: 'a1', tool: 'Bash', input: { command: 'rm x' }, summary: 'rm x', status: 'pending' }] : []));
    await render(<RoomScreen />);
    expect(await screen.findByText(/Researcher wants to use/)).toBeTruthy();
    await screen.findByLabelText('Approval needed');
    expect(screen.getAllByText('rm x').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByLabelText('Allow'));
    await waitFor(() => expect(mockApi.answerApproval).toHaveBeenCalledWith(41, 'a1', 'allow'));
  });
});

describe('RoomMessage', () => {
  it('shows a notice as a muted line', async () => {
    await render(<RoomMessage item={{ kind: 'notice', key: 'n1', seq: 1, text: 'Room roster updated.' }} />);
    expect(screen.getByText('Room roster updated.')).toBeTruthy();
  });
});

describe('Composer mentions', () => {
  it('puts a space before a tag added after other text, and limits the length it is told to', async () => {
    await render(<Composer running={false} onSend={jest.fn()} onStop={jest.fn()} mentions={['Researcher', 'everyone']} maxLength={8000} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'hey');
    await fireEvent.press(screen.getByLabelText('Mention everyone'));
    expect(screen.getByLabelText('Message').props.value).toBe('hey @everyone ');
    expect(screen.getByLabelText('Message').props.maxLength).toBe(8000);
  });
});

describe('ApprovalCard in a room', () => {
  it('names the agent that is asking', async () => {
    const item = { kind: 'approval' as const, key: 'a', turnId: 1, approvalId: 'x', tool: 'Bash', approvalKind: 'command', summary: '', input: {}, status: 'pending' as const };
    await render(<ApprovalCard item={item} waiting={1} agentName="Editor" onAnswer={jest.fn()} />);
    expect(screen.getByText(/Editor wants to use/)).toBeTruthy();
  });
});
