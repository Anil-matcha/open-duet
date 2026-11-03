// The form behind creating and editing a room on the phone: its fields, the server's limits, what is sent and how a
// refusal is put into words. The fields follow the web's room settings (frontend/components/chat/RoomSettings.tsx).
// A room holds no setting that loosens anything: its members keep their own approvals, so a phone may make any room.

import { ApiError, describeApiError } from './api';
import type { Room } from './rooms';

export const ROOM_NAME_MAX = 80;
export const BULLETIN_MAX = 12000;
export const MEMBERS_MAX = 12;

export type ResponderKind = 'mentions' | 'member' | 'everyone';

// Who answers a message that tags nobody (docs/TEAMS.md). The web's first choice is the default.
export const RESPONDER_OPTIONS: { value: ResponderKind; label: string; description: string }[] = [
  { value: 'mentions', label: 'Only tagged members', description: 'Only the members you tag with @ reply.' },
  { value: 'member', label: 'One member', description: 'One member replies when you tag nobody.' },
  { value: 'everyone', label: 'Everyone', description: 'Every member replies, one at a time.' },
];

export type RoomDraft = {
  name: string;
  bulletin: string;
  member_ids: number[];
  default_responder_kind: ResponderKind;
  /** Only used when the kind is 'member'; must be one of the members. */
  default_responder_agent_id: number | null;
};

export const EMPTY_ROOM_DRAFT: RoomDraft = {
  name: '',
  bulletin: '',
  member_ids: [],
  default_responder_kind: 'mentions',
  default_responder_agent_id: null,
};

function asKind(kind: string | undefined): ResponderKind {
  return kind === 'member' || kind === 'everyone' ? kind : 'mentions';
}

export function draftFromRoom(room: Room): RoomDraft {
  const kind = asKind(room.default_responder_kind);
  return {
    name: room.name,
    bulletin: room.bulletin ?? '',
    member_ids: room.members.map((member) => member.agent_id),
    default_responder_kind: kind,
    default_responder_agent_id: kind === 'member' ? (room.default_responder_agent_id ?? null) : null,
  };
}

export type RoomErrors = Partial<Record<'name' | 'bulletin' | 'members' | 'responder', string>>;

/** What the server would refuse, found before anything is sent. Empty means the draft can be saved. */
export function validateRoomDraft(draft: RoomDraft): RoomErrors {
  const errors: RoomErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Give the room a name.';
  else if (name.length > ROOM_NAME_MAX) errors.name = `Use at most ${ROOM_NAME_MAX} characters.`;
  if (draft.bulletin.length > BULLETIN_MAX) errors.bulletin = `Use at most ${BULLETIN_MAX} characters.`;
  if (draft.member_ids.length < 1) errors.members = 'Choose at least one member.';
  else if (draft.member_ids.length > MEMBERS_MAX) errors.members = `Choose at most ${MEMBERS_MAX} members.`;
  if (draft.default_responder_kind === 'member') {
    if (draft.default_responder_agent_id === null) errors.responder = 'Choose which member replies.';
    else if (!draft.member_ids.includes(draft.default_responder_agent_id)) errors.responder = 'That member is not in this room.';
  }
  return errors;
}

export function hasRoomErrors(errors: RoomErrors): boolean {
  return Object.keys(errors).length > 0;
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));

export function isRoomDirty(draft: RoomDraft, original: RoomDraft): boolean {
  return (
    draft.name.trim() !== original.name.trim() ||
    draft.bulletin !== original.bulletin ||
    !sameSet(draft.member_ids, original.member_ids) ||
    draft.default_responder_kind !== original.default_responder_kind ||
    draft.default_responder_agent_id !== original.default_responder_agent_id
  );
}

/** Adds or removes one member, keeping the order they were chosen in and never going over the limit. */
export function toggleMember(draft: RoomDraft, agentId: number): RoomDraft {
  const has = draft.member_ids.includes(agentId);
  if (!has && draft.member_ids.length >= MEMBERS_MAX) return draft;
  const member_ids = has ? draft.member_ids.filter((id) => id !== agentId) : [...draft.member_ids, agentId];
  // A responder who leaves the room is dropped: the person must choose another.
  const gone = has && draft.default_responder_agent_id === agentId;
  return { ...draft, member_ids, default_responder_agent_id: gone ? null : draft.default_responder_agent_id };
}

/** The body of a new room. A named responder is sent only for "One member". */
export function toRoomCreateBody(draft: RoomDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name.trim(),
    member_ids: draft.member_ids,
    default_responder_kind: draft.default_responder_kind,
  };
  if (draft.bulletin) body.bulletin = draft.bulletin;
  if (draft.default_responder_kind === 'member') body.default_responder_agent_id = draft.default_responder_agent_id;
  return body;
}

/**
 * Only what changed. A change to who is in the room carries the roster the form was opened with, so the server can
 * refuse it when someone else changed the room meanwhile (`roster_conflict`).
 */
export function toRoomUpdateBody(draft: RoomDraft, original: RoomDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== original.name.trim()) body.name = draft.name.trim();
  if (draft.bulletin !== original.bulletin) body.bulletin = draft.bulletin;
  if (!sameSet(draft.member_ids, original.member_ids)) {
    body.member_ids = draft.member_ids;
    body.expected_member_ids = original.member_ids;
  }
  if (draft.default_responder_kind !== original.default_responder_kind || draft.default_responder_agent_id !== original.default_responder_agent_id) {
    body.default_responder_kind = draft.default_responder_kind;
    body.default_responder_agent_id = draft.default_responder_kind === 'member' ? draft.default_responder_agent_id : null;
  }
  return body;
}

export type RoomProblem = { field: 'name' | null; message: string };

/** A refused save or delete in words a person can act on. A name already in use belongs to the name field. */
export function describeRoomError(error: unknown): RoomProblem {
  if (error instanceof ApiError) {
    switch (error.errorCode) {
      case 'room_name_taken':
        return { field: 'name', message: 'You already have a room with this name. Choose another.' };
      case 'roster_conflict':
        return { field: null, message: 'This room’s members changed while you were editing. Go back, open its settings again and redo the change.' };
      case 'member_busy':
        return { field: null, message: 'A member you removed is still working. Stop the room, wait for them to finish, then save again.' };
      case 'invalid_responder':
        return { field: null, message: 'Choose a member who is in the room to reply.' };
      case 'invalid_members':
      case 'unreachable_agent':
        return { field: null, message: 'One of the chosen agents cannot join this room. Choose different members.' };
      case 'room_not_found':
        return { field: null, message: 'This room no longer exists.' };
      case 'scope_denied':
        return { field: null, message: 'This phone was not paired to manage rooms. Pair it again with a “Chat, files and agents” code.' };
    }
    if (error.status === 422) return { field: null, message: 'The server did not accept these settings. Check the fields and try again.' };
  }
  return { field: null, message: describeApiError(error) };
}
