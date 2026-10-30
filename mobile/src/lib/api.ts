// The authenticated calls the chat screens make, as a paired chat-scope device (docs/AUTH.md).
// Responses are decoded tolerantly: only the fields the app uses are named, unknown ones are ignored.

import type { Agent } from './agents';
import { buildMultipart, type Attachment } from './attachments';
import { readFolder, readPreview } from './files';
import type { ApprovalRow, Room } from './rooms';
import { readSearchPage, SEARCH_PAGE_SIZE } from './search';

export type Session = { server: string; token: string };

export type Thread = {
  id: number;
  title: string | null;
  provider: string;
  model: string | null;
  session_state: string;
  /** The agent this conversation was started from, or null (none, or since deleted). */
  agent_id?: number | null;
  workspace_path?: string | null;
  last_seq: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ThreadDetail = Thread & { active_turn_id: number | null };

/** A frame of a thread's stream, or a stored event from the paged list. */
export type ThreadEvent = {
  seq?: number;
  type: string;
  turn_id?: number | null;
  data: Record<string, unknown>;
};

export type EventsPage = { events: ThreadEvent[]; next_after: number; has_more: boolean };

export class ApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;

  constructor(status: number, errorCode: string | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 30_000;
// A photo over a mobile connection can take a while.
const UPLOAD_TIMEOUT_MS = 120_000;

type Raw = { body: Uint8Array; contentType: string };

/** `{"detail": "text"}` or `{"detail": {"error_code": "...", "message": "..."}}`; anything else is generic. */
async function errorFrom(response: Response): Promise<ApiError> {
  let code: string | null = null;
  let message = '';
  try {
    const body = (await response.json()) as { detail?: unknown } | null;
    const detail = body?.detail;
    if (typeof detail === 'string') message = detail;
    else if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const record = detail as { error_code?: unknown; message?: unknown };
      if (typeof record.error_code === 'string') code = record.error_code;
      if (typeof record.message === 'string') message = record.message;
    }
  } catch {
    // no readable body: the status alone is used
  }
  return new ApiError(response.status, code, message);
}

export function createApi(session: Session, options: { onRevoked?: () => void; fetchImpl?: FetchLike } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown, raw?: Raw): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), raw ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${session.server}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: 'application/json',
          ...(raw ? { 'Content-Type': raw.contentType } : body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        // The runtime accepts bytes; React Native's declared body types do not list them.
        body: raw ? (raw.body as unknown as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(0, 'unreachable', '');
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      options.onRevoked?.();
      throw new ApiError(401, 'session_invalid', '');
    }
    if (!response.ok) throw await errorFrom(response);
    return (await response.json()) as T;
  }

  return {
    session,
    listThreads: () => request<Thread[]>('GET', '/threads?limit=100'),
    // Titles and messages containing every word, newest first, a page at a time (`offset` is the page's start).
    searchConversations: async (query: string, offset = 0, limit = SEARCH_PAGE_SIZE) =>
      readSearchPage(await request<unknown>('GET', `/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`), query),
    // Engine and model are left out, so the server's own default (or the agent's) applies.
    createThread: (agentId?: number) => request<Thread>('POST', '/threads', agentId === undefined ? {} : { agent_id: agentId }),
    // Not archived ones, pinned first.
    listAgents: () => request<Agent[]>('GET', '/agents'),
    getThread: (id: number) => request<ThreadDetail>('GET', `/threads/${id}`),
    listEvents: (id: number, after: number, limit = 500) =>
      request<EventsPage>('GET', `/threads/${id}/events?after=${after}&limit=${limit}`),
    sendTurn: (id: number, text: string, attachmentIds: string[] = []) =>
      request<{ id: number }>('POST', `/threads/${id}/turns`, attachmentIds.length ? { prompt_text: text, attachment_ids: attachmentIds } : { prompt_text: text }),
    // Stored for this conversation's next message; send the returned id with the turn.
    uploadAttachment: (id: number, file: { name: string; mime: string; bytes: Uint8Array }) =>
      request<Attachment>('POST', `/threads/${id}/attachments`, undefined, buildMultipart('file', file.name, file.mime, file.bytes)),
    /** Where an attached image can be fetched from; the request needs the same bearer token. */
    attachmentSource: (id: number, attachmentId: string) => ({
      uri: `${session.server}/api/v1/threads/${id}/attachments/${attachmentId}`,
      headers: { Authorization: `Bearer ${session.token}` },
    }),
    // Workspace files need a pairing code made with "Chat and files"; without it the server answers 403 `scope_denied`.
    listFiles: async (id: number, path = '') => readFolder(await request<unknown>('GET', `/threads/${id}/files?path=${encodeURIComponent(path)}`)),
    previewFile: async (id: number, path: string) => readPreview(await request<unknown>('GET', `/threads/${id}/files/content?path=${encodeURIComponent(path)}`)),
    /** Where an image's bytes (or any file's, for a download) can be fetched from; the request needs the same bearer token. */
    fileSource: (id: number, path: string, kind: 'raw' | 'download') => ({
      uri: `${session.server}/api/v1/threads/${id}/files/${kind}?path=${encodeURIComponent(path)}`,
      headers: { Authorization: `Bearer ${session.token}` },
    }),
    stopTurn: (id: number) => request<{ turn_id: number }>('POST', `/threads/${id}/stop`, {}),
    // Rooms (docs/MOBILE.md): a chat-only device may read, post, stop and answer, not create or change them.
    listRooms: () => request<Room[]>('GET', '/rooms'),
    getRoom: (id: number) => request<Room>('GET', `/rooms/${id}`),
    postRoomMessage: (id: number, text: string) => request<{ seq: number }>('POST', `/rooms/${id}/messages`, { text }),
    // Stops every agent working in the room.
    stopRoom: (id: number) => request<unknown>('POST', `/rooms/${id}/stop`, {}),
    markRoomRead: (id: number, seq: number) => request<{ seq: number }>('POST', `/rooms/${id}/read`, { seq }),
    // Without saying which thread each belongs to; see `loadRoomApprovals`.
    listRoomApprovals: (id: number) => request<ApprovalRow[]>('GET', `/rooms/${id}/approvals`),
    listThreadApprovals: (id: number) => request<ApprovalRow[]>('GET', `/threads/${id}/approvals?status=pending`),
    // First answer wins; one already answered, expired or cancelled is a 409 `approval_not_waiting`.
    answerApproval: (threadId: number, approvalId: string, decision: 'allow' | 'deny') =>
      request<{ status: string; decision: string }>('POST', `/threads/${threadId}/approvals/${encodeURIComponent(approvalId)}`, { decision }),
  };
}

export type Api = ReturnType<typeof createApi>;

export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const message = error.message;
  switch (error.status) {
    case 0:
      return 'Could not reach your server. Check your connection.';
    case 401:
      return 'Your server signed this phone out. Pair it again to continue.';
    case 403:
      return /local execution is disabled/i.test(message)
        ? 'Your server has agents turned off. Set LOCAL_EXECUTION_ENABLED=true on the server.'
        : message || 'Your server refused this request.';
    case 413:
      return message || 'That file is too large.';
    case 422:
      return message || 'Your server did not accept that request.';
    case 404:
      if (/approval/i.test(message)) return 'That request no longer exists.';
      return /room/i.test(message) ? 'That room no longer exists.' : 'That conversation no longer exists.';
    case 409:
      if (error.errorCode === 'turn_running') return 'An answer is already running. Wait for it, or stop it.';
      if (error.errorCode === 'approval_not_waiting') return 'That request is no longer waiting for an answer.';
      if (error.errorCode === 'no_running_turn') return 'Nothing is running in this conversation.';
      if (error.errorCode === 'session_broken') return 'This conversation could not be continued. Start a new one.';
      return message || 'That is not possible right now.';
    case 503:
      return message || 'The engine is not available on your server.';
    default:
      return error.status >= 500 ? 'Your server hit an error. Try again in a moment.' : message || 'Something went wrong. Try again.';
  }
}

/** Says what went wrong with a workspace file, using the server's own wording where it gives a reason. */
export function describeFileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.errorCode === 'scope_denied') {
      return 'This phone was paired without file access. On your server open Settings → Devices, create a code with Access set to “Chat and files”, and pair again.';
    }
    if (error.status > 0 && error.status < 500 && error.status !== 401 && error.message) return error.message;
  }
  return describeApiError(error);
}
