// Rooms: a shared conversation where you and several of your agents talk. The phone lists rooms, reads
// them as they happen, posts to them, stops the agents and answers their approvals. Creating a room or
// changing who is in it is not allowed for a chat-only device (docs/AUTH.md); that stays in the web app.
//
// A room's messages are the stored events of its own thread, so the phone follows that thread with the
// same stream it uses for a conversation. This file is plain TypeScript: no React, no network of its own.

import type { Api, ThreadEvent } from './api';
import type { TranscriptItem } from './transcript';

export type RoomMember = { agent_id: number; name: string; held: boolean; member_thread_id: number | null };

export type Dispatch = { id: number; agent_id: number; message_seq: number; status: string; reason: string };

export type Room = {
  id: number;
  name: string;
  thread_id: number;
  last_seq: number;
  last_read_seq: number;
  unread: boolean;
  default_responder_kind: string;
  members: RoomMember[];
  dispatches: Dispatch[];
};

export type RoomItem =
  | { kind: 'message'; key: string; seq: number; author: string; mine: boolean; text: string }
  | { kind: 'notice'; key: string; seq: number; text: string };

export type RoomFeed = { items: RoomItem[]; lastSeq: number };

export const emptyFeed = (): RoomFeed => ({ items: [], lastSeq: 0 });

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Messages and notices become rows; anything else on the room's thread is not drawn. Each stored event is applied once. */
export function applyRoomEvents(state: RoomFeed, events: ThreadEvent[]): RoomFeed {
  let next = state;
  for (const event of events) {
    if (typeof event.seq !== 'number' || event.seq <= next.lastSeq) continue;
    const data = record(event.data);
    const base = { ...next, lastSeq: event.seq };
    if (event.type === 'room.message') {
      const author = record(data.author);
      next = {
        ...base,
        items: [...next.items, { kind: 'message', key: `m${event.seq}`, seq: event.seq, author: text(author.label) || (author.kind === 'person' ? 'You' : 'Agent'), mine: author.kind === 'person', text: text(data.text) }],
      };
    } else if (event.type === 'room.notice') {
      next = { ...base, items: [...next.items, { kind: 'notice', key: `n${event.seq}`, seq: event.seq, text: text(data.text) }] };
    } else {
      next = base;
    }
  }
  return next;
}

/** Something is still queued or running for this room, so there is something to stop. */
export function roomBusy(room: Room | null): boolean {
  return !!room?.dispatches.some((dispatch) => dispatch.status === 'queued' || dispatch.status === 'running');
}

/** The names that can be tagged with `@`, `everyone` last. A member that is on hold would not answer, so it is left out. */
export function mentionNames(room: Room | null): string[] {
  if (!room) return [];
  return [...room.members.filter((member) => !member.held).map((member) => member.name), 'everyone'];
}

/** Who is working on something now, by name. */
export function workingNames(room: Room | null): string[] {
  if (!room) return [];
  const active = new Set(room.dispatches.filter((dispatch) => dispatch.status === 'queued' || dispatch.status === 'running').map((dispatch) => dispatch.agent_id));
  return room.members.filter((member) => active.has(member.agent_id)).map((member) => member.name);
}

/** A request that is waiting on one of the room's agents. It is answered on that agent's own thread. */
export type RoomApproval = Extract<TranscriptItem, { kind: 'approval' }> & { threadId: number; agentName: string };

export type ApprovalRow = { id: string; turn_id?: number; tool?: string; input?: Record<string, unknown>; summary?: string | null; kind?: string | null; status?: string };

/**
 * The room's pending approvals. The room lists them without saying which thread each belongs to, and an
 * answer goes to that thread, so each member's own thread is asked only when the room has something pending.
 */
export async function loadRoomApprovals(api: Pick<Api, 'listRoomApprovals' | 'listThreadApprovals'>, room: Room): Promise<RoomApproval[]> {
  const waiting = await api.listRoomApprovals(room.id);
  if (waiting.length === 0) return [];
  const wanted = new Set(waiting.map((approval) => approval.id));
  const found: RoomApproval[] = [];
  for (const member of room.members) {
    if (member.member_thread_id === null) continue;
    let rows: ApprovalRow[];
    try {
      rows = await api.listThreadApprovals(member.member_thread_id);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (!wanted.has(row.id) || row.status !== 'pending') continue;
      found.push({
        kind: 'approval',
        key: `a${row.id}`,
        turnId: typeof row.turn_id === 'number' ? row.turn_id : null,
        approvalId: row.id,
        tool: row.tool ?? 'tool',
        approvalKind: row.kind ?? 'other',
        summary: row.summary ?? '',
        input: row.input ?? {},
        status: 'pending',
        threadId: member.member_thread_id,
        agentName: member.name,
      });
    }
  }
  return found;
}
