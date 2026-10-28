import { ApiError, createApi, describeApiError } from '@/lib/api';
import { relativeTime } from '@/lib/time';

type Reply = { status: number; body?: unknown };

function fakeFetch(reply: Reply | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => {
        if (reply.body === undefined) throw new Error('no body');
        return reply.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const session = { server: 'https://dots.example.com', token: 'ods_t' };

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected the call to fail');
}

describe('createApi', () => {
  it('sends the bearer token and a JSON body, and returns the decoded answer', async () => {
    const { impl, calls } = fakeFetch({ status: 202, body: { id: 4 } });
    const api = createApi(session, { fetchImpl: impl });
    expect(await api.sendTurn(9, 'hello')).toEqual({ id: 4 });
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/threads/9/turns');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ods_t');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt_text: 'hello' });
  });

  it('creates a thread without choosing an engine, model or agent', async () => {
    const { impl, calls } = fakeFetch({ status: 201, body: { id: 1 } });
    await createApi(session, { fetchImpl: impl }).createThread();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });

  it('sends no body and no content type on a read', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: [] });
    await createApi(session, { fetchImpl: impl }).listThreads();
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/threads?limit=100');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(calls[0].init.body).toBeUndefined();
  });

  it('tells the app the session was revoked on a 401', async () => {
    const onRevoked = jest.fn();
    const error = await failure(createApi(session, { fetchImpl: fakeFetch({ status: 401 }).impl, onRevoked }).listThreads());
    expect(error.status).toBe(401);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('reads coded and plain error details', async () => {
    const coded = await failure(createApi(session, { fetchImpl: fakeFetch({ status: 409, body: { detail: { error_code: 'turn_running', message: 'busy' } } }).impl }).sendTurn(1, 'x'));
    expect(coded).toMatchObject({ status: 409, errorCode: 'turn_running' });
    const plain = await failure(createApi(session, { fetchImpl: fakeFetch({ status: 403, body: { detail: 'Local execution is disabled.' } }).impl }).listThreads());
    expect(plain.message).toBe('Local execution is disabled.');
  });

  it('answers an approval with the decision and an encoded id', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: { status: 'recorded', decision: 'allow' } });
    await createApi(session, { fetchImpl: impl }).answerApproval(4, 'toolu_01/ab', 'allow');
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/threads/4/approvals/toolu_01%2Fab');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ decision: 'allow' });
  });

  it('reports an unreachable server', async () => {
    const error = await failure(createApi(session, { fetchImpl: fakeFetch(new TypeError('Network request failed')).impl }).listThreads());
    expect(error.status).toBe(0);
  });
});

describe('describeApiError', () => {
  it('explains the failures a person can act on', () => {
    expect(describeApiError(new ApiError(0, 'unreachable', ''))).toMatch(/could not reach/i);
    expect(describeApiError(new ApiError(403, null, 'Local execution is disabled. Set LOCAL_EXECUTION_ENABLED=true ...'))).toMatch(/LOCAL_EXECUTION_ENABLED=true/);
    expect(describeApiError(new ApiError(409, 'turn_running', ''))).toMatch(/already running/i);
    expect(describeApiError(new ApiError(409, 'approval_not_waiting', ''))).toMatch(/no longer waiting/i);
    expect(describeApiError(new ApiError(404, null, 'Approval not found'))).toMatch(/request no longer exists/i);
    expect(describeApiError(new ApiError(404, null, 'Thread not found'))).toMatch(/conversation no longer exists/i);
    expect(describeApiError(new ApiError(503, 'provider_unavailable', 'Claude is not installed.'))).toBe('Claude is not installed.');
    expect(describeApiError(new ApiError(500, null, ''))).toMatch(/server hit an error/i);
    expect(describeApiError(new Error('boom'))).toMatch(/something went wrong/i);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  it('says how long ago', () => {
    expect(relativeTime('2026-10-27T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-27T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-27T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-25T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('not a date', now)).toBe('');
  });
});
