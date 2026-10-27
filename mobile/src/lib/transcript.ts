// Turns a thread's events into what the chat shows. Pure: no React, no network.
//
// Stored events arrive in order with a seq. Applying one that is not newer than the last is a no-op,
// so a replay after a reconnect can never show anything twice. Typing text (text.delta) has no seq and
// is never stored: it is a preview that the stored assistant.message replaces.
//
// v1 draws messages, one-line tool steps, approvals and how a turn ended. Metadata events with nothing
// to show are skipped; any other type becomes one muted "unsupported" row, so the app never fails on a
// newer server.

import type { ThreadEvent } from './api';

export type TurnEndStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';

export type TranscriptItem =
  | { kind: 'user'; key: string; turnId: number | null; text: string }
  | { kind: 'assistant'; key: string; turnId: number | null; text: string; incomplete: boolean }
  | { kind: 'tool'; key: string; turnId: number | null; callId: string; name: string; summary: string; state: 'running' | 'done' | 'error' | 'stopped' }
  | { kind: 'approval'; key: string; turnId: number | null; approvalId: string; tool: string; summary: string; status: ApprovalStatus }
  | { kind: 'turn_end'; key: string; turnId: number | null; status: Exclude<TurnEndStatus, 'completed'>; error: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'unsupported'; key: string; type: string };

export type Transcript = {
  items: TranscriptItem[];
  /** The seq of the newest stored event applied; a reconnect resumes after it. */
  lastSeq: number;
  /** The turn that has started and not yet ended, if any. */
  runningTurnId: number | null;
  /** The message being typed right now, or null. */
  typing: string | null;
};

export function emptyTranscript(): Transcript {
  return { items: [], lastSeq: 0, runningTurnId: null, typing: null };
}

// Events that carry nothing a phone user needs to see.
const SKIPPED = new Set(['runtime.status', 'skill.used', 'memory.recalled', 'context.compacted', 'engine.switched']);

const TURN_END: Record<string, TurnEndStatus> = {
  'turn.completed': 'completed',
  'turn.failed': 'failed',
  'turn.cancelled': 'cancelled',
  'turn.interrupted': 'interrupted',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function approvalStatus(value: unknown): ApprovalStatus {
  switch (value) {
    case 'allow':
    case 'allowed':
      return 'allowed';
    case 'deny':
    case 'denied':
      return 'denied';
    case 'expired':
      return 'expired';
    default:
      return 'cancelled';
  }
}

// A turn that ended cannot be waiting for anyone or still running a tool.
function closeTurn(items: TranscriptItem[], turnId: number | null): TranscriptItem[] {
  const open = (item: TranscriptItem) =>
    (item.kind === 'approval' && item.turnId === turnId && item.status === 'pending') ||
    (item.kind === 'tool' && item.turnId === turnId && item.state === 'running');
  if (!items.some(open)) return items;
  return items.map((item) => {
    if (!open(item)) return item;
    return item.kind === 'approval' ? { ...item, status: 'cancelled' as const } : { ...(item as Extract<TranscriptItem, { kind: 'tool' }>), state: 'stopped' as const };
  });
}

function applyTyping(state: Transcript, event: ThreadEvent): Transcript {
  const data = record(event.data);
  const chunk = text(data.text);
  // "replace" is a snapshot of the whole message so far (sent once when a stream connects mid-message).
  return { ...state, typing: data.mode === 'replace' ? chunk : (state.typing ?? '') + chunk };
}

export function applyEvent(state: Transcript, event: ThreadEvent): Transcript {
  if (event.type === 'text.delta') return applyTyping(state, event);
  // Only stored events carry a seq; anything else is not part of the transcript.
  if (typeof event.seq !== 'number' || event.seq <= state.lastSeq) return state;

  const key = `e${event.seq}`;
  const data = record(event.data);
  const turnId = typeof event.turn_id === 'number' ? event.turn_id : null;
  const base: Transcript = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case 'turn.started':
      return { ...base, runningTurnId: turnId, typing: null, items: [...state.items, { kind: 'user', key, turnId, text: text(data.prompt_text) }] };

    case 'assistant.message':
      return {
        ...base,
        typing: null,
        items: [...state.items, { kind: 'assistant', key, turnId, text: text(data.text), incomplete: data.incomplete === true }],
      };

    case 'tool.started':
      return {
        ...base,
        items: [...state.items, { kind: 'tool', key, turnId, callId: text(data.call_id), name: text(data.name) || 'tool', summary: text(data.summary), state: 'running' }],
      };

    case 'tool.completed': {
      const callId = text(data.call_id);
      const finished: 'done' | 'error' = data.ok === false ? 'error' : 'done';
      let matched = false;
      const items = state.items.map((item) => {
        if (item.kind === 'tool' && item.callId === callId && item.state === 'running') {
          matched = true;
          return { ...item, state: finished };
        }
        return item;
      });
      // A completion whose start was never seen is still shown, not dropped.
      if (!matched) items.push({ kind: 'tool', key, turnId, callId, name: 'tool', summary: '', state: finished });
      return { ...base, items };
    }

    case 'approval.requested':
      return {
        ...base,
        items: [...state.items, { kind: 'approval', key, turnId, approvalId: text(data.approval_id), tool: text(data.tool) || 'tool', summary: text(data.summary), status: 'pending' }],
      };

    case 'approval.resolved': {
      const approvalId = text(data.approval_id);
      const status = approvalStatus(data.status);
      return {
        ...base,
        items: state.items.map((item) => (item.kind === 'approval' && item.approvalId === approvalId && item.status === 'pending' ? { ...item, status } : item)),
      };
    }

    case 'turn.completed':
    case 'turn.failed':
    case 'turn.cancelled':
    case 'turn.interrupted': {
      const status = TURN_END[event.type];
      const closed = closeTurn(state.items, turnId);
      return {
        ...base,
        runningTurnId: turnId === state.runningTurnId || turnId === null ? null : state.runningTurnId,
        typing: null,
        // A normal finish needs no row; the answer is the end of the turn.
        items: status === 'completed' ? closed : [...closed, { kind: 'turn_end', key, turnId, status, error: text(data.error) }],
      };
    }

    case 'session.reset':
      return { ...base, items: [...state.items, { kind: 'note', key, text: text(data.message) || 'The conversation was started over.' }] };

    default:
      if (SKIPPED.has(event.type)) return base;
      return { ...base, items: [...state.items, { kind: 'unsupported', key, type: event.type }] };
  }
}

export function applyEvents(state: Transcript, events: ThreadEvent[]): Transcript {
  return events.reduce(applyEvent, state);
}
