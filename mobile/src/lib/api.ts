// The authenticated calls the chat screens make, as a paired chat-scope device (docs/AUTH.md).
// Responses are decoded tolerantly: only the fields the app uses are named, unknown ones are ignored.

export type Session = { server: string; token: string };

export type Thread = {
  id: number;
  title: string | null;
  provider: string;
  model: string | null;
  session_state: string;
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

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${session.server}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
    // Engine, model and agent are left out, so the server's own default applies.
    createThread: () => request<Thread>('POST', '/threads', {}),
    getThread: (id: number) => request<ThreadDetail>('GET', `/threads/${id}`),
    listEvents: (id: number, after: number, limit = 500) =>
      request<EventsPage>('GET', `/threads/${id}/events?after=${after}&limit=${limit}`),
    sendTurn: (id: number, text: string) => request<{ id: number }>('POST', `/threads/${id}/turns`, { prompt_text: text }),
    stopTurn: (id: number) => request<{ turn_id: number }>('POST', `/threads/${id}/stop`, {}),
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
    case 404:
      return 'That conversation no longer exists.';
    case 409:
      if (error.errorCode === 'turn_running') return 'An answer is already running. Wait for it, or stop it.';
      if (error.errorCode === 'no_running_turn') return 'Nothing is running in this conversation.';
      if (error.errorCode === 'session_broken') return 'This conversation could not be continued. Start a new one.';
      return message || 'That is not possible right now.';
    case 503:
      return message || 'The engine is not available on your server.';
    default:
      return error.status >= 500 ? 'Your server hit an error. Try again in a moment.' : message || 'Something went wrong. Try again.';
  }
}
