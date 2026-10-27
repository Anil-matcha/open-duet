import { checkSession, describePairingError, PairingError, pairDevice, signOutOnServer } from '@/lib/pairing-api';

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; badJson?: boolean };

function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      json: async () => {
        if (reply.badJson) throw new Error('not json');
        return reply.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const chatSession = { token: 'ods_secret', session: { kind: 'device', scopes: ['chat'], label: 'My phone', session_id: 7, owner_configured: true } };
const args = { server: 'https://dots.example.com', code: 'ABCDEFGH', label: 'My phone', allowHttp: false };

async function failure(promise: Promise<unknown>): Promise<PairingError> {
  try {
    await promise;
  } catch (err) {
    return err as PairingError;
  }
  throw new Error('expected the call to fail');
}

describe('pairDevice', () => {
  it('redeems the code at the server and returns the token for a chat session', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: chatSession });
    const session = await pairDevice({ ...args, fetchImpl: impl });
    expect(session).toEqual({ server: 'https://dots.example.com', token: 'ods_secret', sessionId: 7, scopes: ['chat'], label: 'My phone' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/auth/pair');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'ABCDEFGH', label: 'My phone' });
  });

  it('refuses a full-access session and signs that session out on the server', async () => {
    const admin = { token: 'ods_admin', session: { scopes: ['admin', 'chat'], session_id: 9 } };
    const { impl, calls } = fakeFetch({ status: 200, body: admin }, { status: 204 });
    const error = await failure(pairDevice({ ...args, fetchImpl: impl }));
    expect(error.code).toBe('wrong_scope');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://dots.example.com/api/v1/auth/logout');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer ods_admin');
  });

  it('refuses a session without the chat scope', async () => {
    const { impl } = fakeFetch({ status: 200, body: { token: 't', session: { scopes: [] } } }, { status: 204 });
    expect((await failure(pairDevice({ ...args, fetchImpl: impl }))).code).toBe('wrong_scope');
  });

  it('never sends the code over plain http unless allowed', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: chatSession });
    expect((await failure(pairDevice({ ...args, server: 'http://192.168.1.5:8000', fetchImpl: impl }))).code).toBe('insecure');
    expect(calls).toHaveLength(0);
    await pairDevice({ ...args, server: 'http://192.168.1.5:8000', allowHttp: true, fetchImpl: impl });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, 'invalid_code'],
    [409, 'too_many_devices'],
    [421, 'untrusted_host'],
    [403, 'refused'],
    [500, 'server_error'],
    [404, 'not_a_server'],
  ] as const)('maps status %i to %s', async (status, code) => {
    const { impl } = fakeFetch({ status });
    expect((await failure(pairDevice({ ...args, fetchImpl: impl }))).code).toBe(code);
  });

  it('reports the lockout and how long to wait', async () => {
    const { impl } = fakeFetch({ status: 429, headers: { 'retry-after': '540' } });
    const error = await failure(pairDevice({ ...args, fetchImpl: impl }));
    expect(error.code).toBe('locked_out');
    expect(error.retryAfter).toBe(540);
    expect(describePairingError(error)).toContain('540 seconds');
  });

  it('says it is not an Open Dots server when the answer has the wrong shape', async () => {
    for (const reply of [{ status: 200, body: { hello: 'world' } }, { status: 200, badJson: true }, { status: 200, body: { token: 't', session: { scopes: 'chat' } } }]) {
      const { impl } = fakeFetch(reply);
      expect((await failure(pairDevice({ ...args, fetchImpl: impl }))).code).toBe('not_a_server');
    }
  });

  it('ignores fields it does not know', async () => {
    const body = { token: 't', extra: 1, session: { scopes: ['chat'], session_id: 3, label: null, future_field: true } };
    const { impl } = fakeFetch({ status: 200, body });
    expect(await pairDevice({ ...args, fetchImpl: impl })).toMatchObject({ token: 't', sessionId: 3, label: null });
  });

  it('reports an unreachable server', async () => {
    const impl = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect((await failure(pairDevice({ ...args, fetchImpl: impl }))).code).toBe('unreachable');
  });
});

describe('signOutOnServer and checkSession', () => {
  it('signs out with the bearer and never throws', async () => {
    const ok = fakeFetch({ status: 204 });
    expect(await signOutOnServer('https://dots.example.com', 'tok', ok.impl)).toBe(true);
    expect((ok.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await signOutOnServer('https://dots.example.com', 'tok', down)).toBe(false);
  });

  it('reports revoked only for a 401', async () => {
    expect(await checkSession('https://s', 't', fakeFetch({ status: 200, body: {} }).impl)).toBe('valid');
    expect(await checkSession('https://s', 't', fakeFetch({ status: 401 }).impl)).toBe('revoked');
    expect(await checkSession('https://s', 't', fakeFetch({ status: 503 }).impl)).toBe('unknown');
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkSession('https://s', 't', down)).toBe('unknown');
  });
});
