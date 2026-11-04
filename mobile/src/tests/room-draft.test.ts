import { ApiError } from '@/lib/api';
import {
  BULLETIN_MAX,
  describeRoomError,
  draftFromRoom,
  EMPTY_ROOM_DRAFT,
  hasRoomErrors,
  isRoomDirty,
  MEMBERS_MAX,
  toggleMember,
  toRoomCreateBody,
  toRoomUpdateBody,
  validateRoomDraft,
  type RoomDraft,
} from '@/lib/room-draft';
import type { Room } from '@/lib/rooms';

const room: Room = {
  id: 3,
  name: 'Launch',
  thread_id: 40,
  last_seq: 0,
  last_read_seq: 0,
  unread: false,
  bulletin: 'Ship it',
  default_responder_kind: 'member',
  default_responder_agent_id: 1,
  members: [
    { agent_id: 1, name: 'Researcher', held: false, member_thread_id: 41 },
    { agent_id: 2, name: 'Editor', held: true, member_thread_id: 42 },
  ],
  dispatches: [],
};

const valid: RoomDraft = { ...EMPTY_ROOM_DRAFT, name: 'Desk', member_ids: [1, 2] };

describe('draftFromRoom', () => {
  it('reads a room into the form fields', () => {
    expect(draftFromRoom(room)).toEqual({ name: 'Launch', bulletin: 'Ship it', member_ids: [1, 2], default_responder_kind: 'member', default_responder_agent_id: 1 });
  });

  it('copes with a room with no instructions and an unknown routing kind', () => {
    const draft = draftFromRoom({ ...room, bulletin: undefined, default_responder_kind: 'newer', default_responder_agent_id: 2 });
    expect(draft).toMatchObject({ bulletin: '', default_responder_kind: 'mentions', default_responder_agent_id: null });
  });
});

describe('validateRoomDraft', () => {
  it('needs a name and at least one member', () => {
    const errors = validateRoomDraft(EMPTY_ROOM_DRAFT);
    expect(errors.name).toBeTruthy();
    expect(errors.members).toBeTruthy();
    expect(hasRoomErrors(validateRoomDraft(valid))).toBe(false);
    expect(validateRoomDraft({ ...valid, name: '   ' }).name).toBeTruthy();
  });

  it('applies the server limits', () => {
    expect(validateRoomDraft({ ...valid, name: 'x'.repeat(81) }).name).toBeTruthy();
    expect(validateRoomDraft({ ...valid, name: 'x'.repeat(80) }).name).toBeUndefined();
    expect(validateRoomDraft({ ...valid, bulletin: 'x'.repeat(BULLETIN_MAX + 1) }).bulletin).toBeTruthy();
    expect(validateRoomDraft({ ...valid, member_ids: Array.from({ length: MEMBERS_MAX + 1 }, (_, i) => i) }).members).toBeTruthy();
    expect(validateRoomDraft({ ...valid, member_ids: Array.from({ length: MEMBERS_MAX }, (_, i) => i) }).members).toBeUndefined();
  });

  it('needs a responder from the members when "One member" is chosen', () => {
    expect(validateRoomDraft({ ...valid, default_responder_kind: 'member' }).responder).toBeTruthy();
    expect(validateRoomDraft({ ...valid, default_responder_kind: 'member', default_responder_agent_id: 9 }).responder).toBeTruthy();
    expect(validateRoomDraft({ ...valid, default_responder_kind: 'member', default_responder_agent_id: 2 }).responder).toBeUndefined();
    // Any other routing needs no responder.
    expect(validateRoomDraft({ ...valid, default_responder_kind: 'everyone' }).responder).toBeUndefined();
  });
});

describe('toggleMember', () => {
  it('adds and removes members in the order chosen', () => {
    let draft = toggleMember(EMPTY_ROOM_DRAFT, 5);
    draft = toggleMember(draft, 3);
    expect(draft.member_ids).toEqual([5, 3]);
    expect(toggleMember(draft, 5).member_ids).toEqual([3]);
  });

  it('never goes past twelve members', () => {
    const full = { ...EMPTY_ROOM_DRAFT, member_ids: Array.from({ length: MEMBERS_MAX }, (_, i) => i + 1) };
    expect(toggleMember(full, 99)).toBe(full);
    expect(toggleMember(full, 1).member_ids).toHaveLength(MEMBERS_MAX - 1);
  });

  it('drops a responder who leaves, so another must be chosen', () => {
    const draft = { ...valid, default_responder_kind: 'member' as const, default_responder_agent_id: 2 };
    expect(toggleMember(draft, 2)).toMatchObject({ member_ids: [1], default_responder_agent_id: null });
    expect(toggleMember(draft, 1)).toMatchObject({ member_ids: [2], default_responder_agent_id: 2 });
  });
});

describe('isRoomDirty', () => {
  const original = draftFromRoom(room);

  it('is false for the same draft, however the members are ordered or the name spaced', () => {
    expect(isRoomDirty({ ...original }, original)).toBe(false);
    expect(isRoomDirty({ ...original, member_ids: [2, 1], name: ' Launch ' }, original)).toBe(false);
  });

  it('is true when anything changes', () => {
    expect(isRoomDirty({ ...original, bulletin: 'x' }, original)).toBe(true);
    expect(isRoomDirty({ ...original, member_ids: [1] }, original)).toBe(true);
    expect(isRoomDirty({ ...original, default_responder_kind: 'everyone' }, original)).toBe(true);
  });
});

describe('toRoomCreateBody', () => {
  it('sends the name trimmed and the routing as chosen', () => {
    expect(toRoomCreateBody({ ...valid, name: ' Desk ' })).toEqual({ name: 'Desk', member_ids: [1, 2], default_responder_kind: 'mentions' });
  });

  it('sends instructions only when written, and a responder only for "One member"', () => {
    expect(toRoomCreateBody({ ...valid, bulletin: 'Be kind', default_responder_kind: 'member', default_responder_agent_id: 2 })).toEqual({
      name: 'Desk',
      member_ids: [1, 2],
      default_responder_kind: 'member',
      bulletin: 'Be kind',
      default_responder_agent_id: 2,
    });
    expect(toRoomCreateBody({ ...valid, default_responder_kind: 'everyone', default_responder_agent_id: 2 })).not.toHaveProperty('default_responder_agent_id');
  });
});

describe('toRoomUpdateBody', () => {
  const original = draftFromRoom(room);

  it('sends nothing for an unchanged draft', () => {
    expect(toRoomUpdateBody({ ...original }, original)).toEqual({});
  });

  it('sends only what changed', () => {
    expect(toRoomUpdateBody({ ...original, name: 'Renamed', bulletin: '' }, original)).toEqual({ name: 'Renamed', bulletin: '' });
  });

  it('sends the roster the form was opened with, so the server can refuse a stale edit', () => {
    expect(toRoomUpdateBody({ ...original, member_ids: [1, 2, 7] }, original)).toEqual({ member_ids: [1, 2, 7], expected_member_ids: [1, 2] });
  });

  it('sends the new routing with a null responder unless it is "One member"', () => {
    expect(toRoomUpdateBody({ ...original, default_responder_kind: 'everyone', default_responder_agent_id: null }, original)).toEqual({ default_responder_kind: 'everyone', default_responder_agent_id: null });
    expect(toRoomUpdateBody({ ...original, default_responder_agent_id: 2 }, original)).toEqual({ default_responder_kind: 'member', default_responder_agent_id: 2 });
  });

  it('moves the responder in the same save that removes the old one', () => {
    const next = { ...original, member_ids: [2], default_responder_agent_id: 2 };
    expect(toRoomUpdateBody(next, original)).toEqual({ member_ids: [2], expected_member_ids: [1, 2], default_responder_kind: 'member', default_responder_agent_id: 2 });
  });
});

describe('describeRoomError', () => {
  it('puts a taken name on the name field', () => {
    expect(describeRoomError(new ApiError(409, 'room_name_taken', ''))).toMatchObject({ field: 'name' });
  });

  it('says what to do for each refusal the server can give', () => {
    expect(describeRoomError(new ApiError(409, 'roster_conflict', '')).message).toMatch(/changed while you were editing/);
    expect(describeRoomError(new ApiError(409, 'member_busy', '')).message).toMatch(/still working/);
    expect(describeRoomError(new ApiError(409, 'invalid_responder', '')).message).toMatch(/member who is in the room/);
    expect(describeRoomError(new ApiError(409, 'unreachable_agent', '')).message).toMatch(/cannot join/);
    expect(describeRoomError(new ApiError(404, 'room_not_found', '')).message).toMatch(/no longer exists/);
    expect(describeRoomError(new ApiError(403, 'scope_denied', '')).message).toMatch(/Chat, files and agents/);
    expect(describeRoomError(new ApiError(422, null, '')).message).toMatch(/did not accept/);
  });

  it('falls back to the general message', () => {
    expect(describeRoomError(new ApiError(0, 'unreachable', '')).field).toBeNull();
    expect(describeRoomError(new Error('boom')).message).toBeTruthy();
  });
});
