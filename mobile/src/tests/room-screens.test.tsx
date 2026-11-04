import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import RoomDetails from '../app/room-details';
import RoomSettings from '../app/room-settings';
import RoomsList from '../app/rooms';
import type { Agent } from '@/lib/agents';
import { ApiError } from '@/lib/api';
import type { Room } from '@/lib/rooms';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
let mockParams: { id: string } = { id: 'new' };
let mockScopes: string[] = ['chat', 'files', 'manage'];
let mockPrevent: { active: boolean; callback?: (options: { repeat: () => void }) => void } = { active: false };

const mockApi = {
  listRooms: jest.fn(),
  getRoom: jest.fn(),
  listAgents: jest.fn(),
  createRoom: jest.fn(),
  updateRoom: jest.fn(),
  deleteRoom: jest.fn(),
  holdRoomMember: jest.fn(),
};

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    Stack: { Screen: () => null },
    useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace, dismissTo: mockDismissTo }),
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
    usePreventRemove: (active: boolean, callback: (options: { repeat: () => void }) => void) => {
      mockPrevent = { active, callback };
    },
  };
});
jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ state: { status: 'paired', server: 'https://dots.example.com', token: 't', label: 'L', scopes: mockScopes } }),
}));
jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));

const agent = (id: number, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, title: null, description: null, provider: 'claude', model: null, approval_mode: 'ask', pinned: false, ...extra });

const room = (extra: Partial<Room> = {}): Room => ({
  id: 3,
  name: 'Launch',
  thread_id: 40,
  last_seq: 0,
  last_read_seq: 0,
  unread: false,
  bulletin: 'Ship it',
  default_responder_kind: 'mentions',
  default_responder_agent_id: null,
  members: [
    { agent_id: 1, name: 'Researcher', held: false, member_thread_id: 41 },
    { agent_id: 2, name: 'Editor', held: true, member_thread_id: 42 },
  ],
  dispatches: [],
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { id: 'new' };
  mockScopes = ['chat', 'files', 'manage'];
  mockPrevent = { active: false };
  mockApi.listRooms.mockResolvedValue([]);
  mockApi.listAgents.mockResolvedValue([agent(1, 'Researcher'), agent(2, 'Editor'), agent(3, 'Writer'), agent(4, 'Old', { archived_at: '2026-11-01T00:00:00Z' })]);
  mockApi.createRoom.mockResolvedValue(room({ id: 9 }));
  mockApi.updateRoom.mockResolvedValue(room());
  mockApi.deleteRoom.mockResolvedValue(undefined);
  mockApi.holdRoomMember.mockResolvedValue({});
  mockApi.getRoom.mockResolvedValue(room());
});

describe('Rooms list', () => {
  it('offers New room to a phone that can manage rooms, and says what a room is', async () => {
    await render(<RoomsList />);
    expect(await screen.findByText(/A room is a shared conversation/)).toBeTruthy();
    await fireEvent.press(screen.getByText('New room'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/room-settings', params: { id: 'new' } });
  });

  it('keeps New room off a chat-only phone, which still sends you to the web app', async () => {
    mockScopes = ['chat'];
    await render(<RoomsList />);
    expect(await screen.findByText(/Rooms are made in the web app/)).toBeTruthy();
    expect(screen.queryByText('New room')).toBeNull();
  });
});

describe('Room settings, creating', () => {
  it('needs a name and a member, then creates the room and opens it', async () => {
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    await fireEvent.press(screen.getByLabelText('Create room'));
    expect(await screen.findByText('Give the room a name.')).toBeTruthy();
    expect(screen.getByText('Choose at least one member.')).toBeTruthy();
    expect(mockApi.createRoom).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('Room name'), ' Desk ');
    await fireEvent.press(screen.getByLabelText('Researcher'));
    await fireEvent.press(screen.getByLabelText('Writer'));
    await fireEvent.changeText(screen.getByLabelText('Shared instructions'), 'Be brief.');
    await fireEvent.press(screen.getByLabelText('Create room'));
    await waitFor(() => expect(mockApi.createRoom).toHaveBeenCalledTimes(1));
    expect(mockApi.createRoom.mock.calls[0][0]).toEqual({ name: 'Desk', member_ids: [1, 3], default_responder_kind: 'mentions', bulletin: 'Be brief.' });
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/rooms/[id]', params: { id: '9' } });
  });

  it('does not offer an archived agent as a member', async () => {
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    expect(screen.getByLabelText('Researcher')).toBeTruthy();
    expect(screen.queryByLabelText('Old')).toBeNull();
  });

  it('shows how many are chosen, and asks for a responder only for "One member"', async () => {
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    await fireEvent.press(screen.getByLabelText('Researcher'));
    expect(screen.getByText('1 of 12')).toBeTruthy();
    expect(screen.queryByLabelText(/^Default responder/)).toBeNull();
    await fireEvent.press(screen.getByLabelText('One member'));
    expect(screen.getByLabelText('Default responder, Choose a member…')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Room name'), 'Desk');
    await fireEvent.press(screen.getByLabelText('Create room'));
    expect(await screen.findByText('Choose which member replies.')).toBeTruthy();
    // Only the room's members are offered; choose one and save with it.
    await fireEvent.press(screen.getByLabelText('Default responder, Choose a member…'));
    expect(screen.getAllByLabelText('Researcher')).toHaveLength(2);
    expect(screen.getAllByLabelText('Writer')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Researcher' }));
    await fireEvent.press(screen.getByLabelText('Create room'));
    await waitFor(() => expect(mockApi.createRoom).toHaveBeenCalled());
    expect(mockApi.createRoom.mock.calls[0][0]).toMatchObject({ default_responder_kind: 'member', default_responder_agent_id: 1 });
  });

  it('puts a name that is already used on the name field', async () => {
    mockApi.createRoom.mockRejectedValue(new ApiError(409, 'room_name_taken', ''));
    await render(<RoomSettings />);
    await fireEvent.changeText(await screen.findByLabelText('Room name'), 'Desk');
    await fireEvent.press(screen.getByLabelText('Researcher'));
    await fireEvent.press(screen.getByLabelText('Create room'));
    expect(await screen.findByText(/already have a room with this name/)).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('asks before leaving with changes', async () => {
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    expect(mockPrevent.active).toBe(false);
    await fireEvent.changeText(screen.getByLabelText('Room name'), 'Desk');
    expect(mockPrevent.active).toBe(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const repeat = jest.fn();
    mockPrevent.callback!({ repeat });
    alert.mock.calls[0][2]!.find((button) => button.text === 'Discard changes')!.onPress!();
    expect(repeat).toHaveBeenCalled();
    alert.mockRestore();
  });

  it('refuses a phone that was not paired to manage rooms', async () => {
    mockScopes = ['chat', 'files'];
    await render(<RoomSettings />);
    expect(screen.getByText(/Chat, files and agents/)).toBeTruthy();
    expect(mockApi.listAgents).not.toHaveBeenCalled();
  });
});

describe('Room settings, editing', () => {
  beforeEach(() => {
    mockParams = { id: '3' };
  });

  it('loads the room and saves only what changed', async () => {
    await render(<RoomSettings />);
    expect((await screen.findByLabelText('Room name')).props.value).toBe('Launch');
    expect(screen.getByLabelText('Save room').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByLabelText('Researcher').props.accessibilityState.checked).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Shared instructions'), 'Ship it today');
    await fireEvent.press(screen.getByLabelText('Save room'));
    await waitFor(() => expect(mockApi.updateRoom).toHaveBeenCalledWith(3, { bulletin: 'Ship it today' }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('sends the roster it was opened with when members change', async () => {
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    await fireEvent.press(screen.getByLabelText('Writer'));
    await fireEvent.press(screen.getByLabelText('Save room'));
    await waitFor(() => expect(mockApi.updateRoom).toHaveBeenCalledWith(3, { member_ids: [1, 2, 3], expected_member_ids: [1, 2] }));
  });

  it('says what to do when the members changed meanwhile', async () => {
    mockApi.updateRoom.mockRejectedValue(new ApiError(409, 'roster_conflict', ''));
    await render(<RoomSettings />);
    await screen.findByLabelText('Room name');
    await fireEvent.press(screen.getByLabelText('Writer'));
    await fireEvent.press(screen.getByLabelText('Save room'));
    expect(await screen.findByText(/members changed while you were editing/)).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('keeps a member whose agent was archived in the list', async () => {
    mockApi.getRoom.mockResolvedValue(room({ members: [{ agent_id: 4, name: 'Old', held: false, member_thread_id: 44 }] }));
    await render(<RoomSettings />);
    expect((await screen.findByLabelText('Old')).props.accessibilityState.checked).toBe(true);
  });

  it('shows why the room could not be read', async () => {
    mockApi.getRoom.mockRejectedValue(new ApiError(404, null, ''));
    await render(<RoomSettings />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('Room details', () => {
  beforeEach(() => {
    mockParams = { id: '3' };
  });

  it('shows the instructions, the routing and the members, held ones marked', async () => {
    await render(<RoomDetails />);
    expect(await screen.findByText('Ship it')).toBeTruthy();
    expect(screen.getByText('Only tagged members')).toBeTruthy();
    expect(screen.getByText('Researcher')).toBeTruthy();
    expect(screen.getByText('Held: skipped until resumed')).toBeTruthy();
  });

  it('holds and resumes a member, then reads the room again', async () => {
    await render(<RoomDetails />);
    await fireEvent.press(await screen.findByLabelText('Hold Researcher'));
    await waitFor(() => expect(mockApi.holdRoomMember).toHaveBeenCalledWith(3, 1, true));
    await fireEvent.press(screen.getByLabelText('Resume Editor'));
    await waitFor(() => expect(mockApi.holdRoomMember).toHaveBeenCalledWith(3, 2, false));
    expect(mockApi.getRoom.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('opens the room settings', async () => {
    await render(<RoomDetails />);
    await fireEvent.press(await screen.findByLabelText('Room settings'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/room-settings', params: { id: '3' } });
  });

  it('deletes only after the room’s name is typed', async () => {
    await render(<RoomDetails />);
    await fireEvent.press(await screen.findByLabelText('Delete room…'));
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(screen.getByLabelText('Delete room permanently').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Room name to confirm'), 'Launc');
    expect(screen.getByLabelText('Delete room permanently').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Room name to confirm'), 'Launch');
    await fireEvent.press(screen.getByLabelText('Delete room permanently'));
    await waitFor(() => expect(mockApi.deleteRoom).toHaveBeenCalledWith(3));
    expect(mockDismissTo).toHaveBeenCalledWith('/rooms');
  });

  it('can be cancelled before deleting', async () => {
    await render(<RoomDetails />);
    await fireEvent.press(await screen.findByLabelText('Delete room…'));
    await fireEvent.press(screen.getByLabelText('Keep room'));
    expect(screen.getByLabelText('Delete room…')).toBeTruthy();
    expect(mockApi.deleteRoom).not.toHaveBeenCalled();
  });

  it('shows why a delete failed and stays on the screen', async () => {
    mockApi.deleteRoom.mockRejectedValue(new ApiError(403, 'scope_denied', ''));
    await render(<RoomDetails />);
    await fireEvent.press(await screen.findByLabelText('Delete room…'));
    await fireEvent.changeText(screen.getByLabelText('Room name to confirm'), 'Launch');
    await fireEvent.press(screen.getByLabelText('Delete room permanently'));
    expect(await screen.findByText(/Chat, files and agents/)).toBeTruthy();
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it('shows a chat-only phone the details but none of the controls', async () => {
    mockScopes = ['chat'];
    await render(<RoomDetails />);
    expect(await screen.findByText('Ship it')).toBeTruthy();
    expect(screen.queryByLabelText('Hold Researcher')).toBeNull();
    expect(screen.queryByLabelText('Room settings')).toBeNull();
    expect(screen.queryByLabelText('Delete room…')).toBeNull();
  });
});
