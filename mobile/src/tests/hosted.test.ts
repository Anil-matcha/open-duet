import {
  createHostedApi,
  describeAvailability,
  describeHostedError,
  HostedError,
  hostedOrigin,
  isBlocked,
  isStarting,
  readWorkspace,
  type Availability,
} from '@/lib/hosted';

const ORIGIN = 'https://suparagent.ai';
const ACCOUNT = 'odm_' + 'a'.repeat(43);
const DEVICE = 'ods_' + 'b'.repeat(43);

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; url?: string };

function fakeFetch(reply: Reply | ((url: string, init: RequestInit) => Reply)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const made = typeof reply === 'function' ? reply(url, init) : reply;
    const status = made.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      url: made.url ?? url,
      headers: { get: (name: string) => made.headers?.[name.toLowerCase()] ?? null },
      json: async () => {
        if (made.body === undefined) throw new Error('no body');
        return made.body;
      },
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const headersOf = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;

describe('hostedOrigin', () => {
  it('is the production service unless a development build names another valid address', () => {
    expect(hostedOrigin(undefined)).toBe(ORIGIN);
    expect(hostedOrigin('')).toBe(ORIGIN);
    expect(hostedOrigin('https://staging.suparagent.ai/')).toBe('https://staging.suparagent.ai');
    expect(hostedOrigin('http://192.168.1.20:8000')).toBe('http://192.168.1.20:8000'); // this network only
  });

  it('ignores an override that does not pass the address rule', () => {
    expect(hostedOrigin('http://example.com')).toBe(ORIGIN); // plain http off this network
    expect(hostedOrigin('ftp://example.com')).toBe(ORIGIN);
    expect(hostedOrigin('not an address')).toBe(ORIGIN);
    expect(hostedOrigin('https://user:pass@evil.example')).toBe(ORIGIN);
  });
});

describe('readWorkspace', () => {
  it('reads the summary, from an answer that wraps it or from the summary itself', () => {
    const summary = { kind: 'personal', plan: 'starter', availability: 'sleeping', retry_after: 30.2, extra: 'ignored' };
    expect(readWorkspace({ workspace: summary })).toEqual({ plan: 'starter', availability: 'sleeping', retryAfter: 31 });
    expect(readWorkspace(summary)).toEqual({ plan: 'starter', availability: 'sleeping', retryAfter: 31 });
  });

  it('reads an unknown or missing state as a problem, never as a blank', () => {
    expect(readWorkspace({ workspace: { plan: 'pro', availability: 'on_fire' } })?.availability).toBe('error');
    expect(readWorkspace({ workspace: { plan: 'pro' } })?.availability).toBe('error');
    expect(readWorkspace({ workspace: { plan: 'pro', availability: 'ready', retry_after: null } })?.retryAfter).toBeNull();
  });

  it('is null when there is nothing to read', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { workspace: null }, { workspace: { availability: 'ready' } }]) {
      expect(readWorkspace(bad)).toBeNull();
    }
  });
});

describe('createHostedApi', () => {
  it('asks for a code with the email and nothing else, and sends no credential', async () => {
    const { impl, calls } = fakeFetch({ status: 202, body: { status: 'if_account_exists_code_sent' } });
    await createHostedApi({ fetchImpl: impl }).startEmail('me@example.com');
    expect(calls[0].url).toBe(`${ORIGIN}/api/v1/accounts/mobile/email/start`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: 'me@example.com' });
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it('signs in with the code and this phone’s id, name and platform, and reads the account session', async () => {
    const { impl, calls } = fakeFetch({
      body: { account_token: ACCOUNT, expires_at: '2027-01-01T00:00:00Z', user: { email: 'me@example.com' }, workspace: { kind: 'personal', plan: 'starter', availability: 'sleeping', retry_after: null } },
    });
    const session = await createHostedApi({ fetchImpl: impl }).verifyEmail({ email: 'me@example.com', code: '123456', deviceId: 'install-1234', label: 'Pixel 8', platform: 'android' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: 'me@example.com', code: '123456', device_id: 'install-1234', label: 'Pixel 8', platform: 'android' });
    expect(session).toEqual({ token: ACCOUNT, expiresAt: '2027-01-01T00:00:00Z', email: 'me@example.com', workspace: { plan: 'starter', availability: 'sleeping', retryAfter: null } });
  });

  it('refuses an answer that is not an account token', async () => {
    for (const body of [{}, { account_token: 'ods_' + 'x'.repeat(43) }, { account_token: 5 }]) {
      const { impl } = fakeFetch({ body });
      await expect(createHostedApi({ fetchImpl: impl }).verifyEmail({ email: 'a@b.co', code: '123456', deviceId: 'install-1234', label: '', platform: 'ios' })).rejects.toMatchObject({ code: 'server_error' });
    }
  });

  it('puts the account token in the Authorization header only, and calls the right paths', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('/devices')) return { status: 201, body: { device_token: DEVICE, scopes: ['chat'], expires_at: 'x', base_url: ORIGIN } };
      if (url.endsWith('/refresh')) return { body: { account_token: ACCOUNT, expires_at: 'x' } };
      if (url.endsWith('/active') || url.endsWith('/logout')) return { status: 204 };
      return { body: { workspace: { plan: 'starter', availability: 'ready' }, user: { email: 'a@b.co' }, expires_at: 'x' } };
    });
    const api = createHostedApi({ fetchImpl: impl });
    await api.session(ACCOUNT);
    await api.status(ACCOUNT);
    await api.wake(ACCOUNT);
    await api.signalActive(ACCOUNT);
    await api.refresh(ACCOUNT);
    await api.createDevice(ACCOUNT, 'files');
    await api.logout(ACCOUNT);
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(`${ORIGIN}/api/v1/accounts/mobile`, '')}`)).toEqual([
      'GET /session', 'GET /workspace/status', 'POST /workspace/wake', 'POST /workspace/active', 'POST /refresh', 'POST /devices', 'POST /logout',
    ]);
    for (const call of calls) {
      expect(headersOf(call).Authorization).toBe(`Bearer ${ACCOUNT}`);
      expect(call.url).not.toContain(ACCOUNT); // never in a URL
      expect(call.url.startsWith(`${ORIGIN}/`)).toBe(true);
    }
    expect(JSON.parse(calls[5].init.body as string)).toEqual({ scope: 'files' });
  });

  it('asks for chat only unless files is asked for', async () => {
    const { impl, calls } = fakeFetch({ status: 201, body: { device_token: DEVICE, scopes: ['chat'], expires_at: 'x', base_url: ORIGIN } });
    await createHostedApi({ fetchImpl: impl }).createDevice(ACCOUNT);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ scope: 'chat' });
  });

  it('keeps its own origin whatever the answer says, and takes only a workspace token as the grant', async () => {
    const { impl } = fakeFetch({ status: 201, body: { device_token: DEVICE, scopes: ['chat', 'files', 7], expires_at: 'x', base_url: 'https://evil.example' } });
    const api = createHostedApi({ fetchImpl: impl });
    const grant = await api.createDevice(ACCOUNT, 'files');
    expect(grant.scopes).toEqual(['chat', 'files']);
    expect(api.origin).toBe(ORIGIN);
    const { impl: wrong } = fakeFetch({ status: 201, body: { device_token: ACCOUNT } });
    await expect(createHostedApi({ fetchImpl: wrong }).createDevice(ACCOUNT)).rejects.toMatchObject({ code: 'server_error' });
  });

  it('reads status without waking and a blank answer as a problem', async () => {
    const { impl } = fakeFetch({ body: {} });
    expect((await createHostedApi({ fetchImpl: impl }).status(ACCOUNT)).availability).toBe('error');
  });

  it('turns a refusal into an error with the service’s own code and wait', async () => {
    const cases: [number, unknown, Record<string, string>, string, number | null][] = [
      [401, { detail: { code: 'code_invalid' } }, {}, 'code_invalid', null],
      [403, { detail: { code: 'no_eligible_workspace' } }, {}, 'no_eligible_workspace', null],
      [402, { detail: { code: 'usage_limit' } }, {}, 'usage_limit', null],
      [409, { detail: { code: 'workspace_not_ready' } }, {}, 'workspace_not_ready', null],
      [429, { detail: { code: 'rate_limited' } }, { 'retry-after': '42' }, 'rate_limited', 42],
      [429, {}, {}, 'rate_limited', null],
      [401, {}, {}, 'session_invalid', null],
      [500, { detail: { code: 'something_new_and_unknown' } }, {}, 'server_error', null],
      [502, 'not an object', {}, 'server_error', null],
    ];
    for (const [status, body, headers, code, retryAfter] of cases) {
      const { impl } = fakeFetch({ status, body, headers });
      await expect(createHostedApi({ fetchImpl: impl }).wake(ACCOUNT)).rejects.toMatchObject({ status, code, retryAfter });
    }
  });

  it('reports a network failure, a hang and an answer from somewhere else as unreachable', async () => {
    const failing = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(createHostedApi({ fetchImpl: failing }).status(ACCOUNT)).rejects.toMatchObject({ code: 'unreachable', status: 0 });
    const { impl } = fakeFetch({ url: 'http://evil.example/redirected', body: { workspace: { plan: 'x', availability: 'ready' } } });
    await expect(createHostedApi({ fetchImpl: impl }).status(ACCOUNT)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('logs out best effort: a failure is not an error', async () => {
    const failing = jest.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await createHostedApi({ fetchImpl: failing }).logout(ACCOUNT)).toBe(false);
    const { impl } = fakeFetch({ status: 200, body: { status: 'signed_out' } });
    expect(await createHostedApi({ fetchImpl: impl }).logout(ACCOUNT)).toBe(true);
  });

  it('never puts a token in an error message', async () => {
    const { impl } = fakeFetch({ status: 401, body: { detail: { code: 'session_invalid', message: `bad ${ACCOUNT}` } } });
    try {
      await createHostedApi({ fetchImpl: impl }).status(ACCOUNT);
      throw new Error('should have failed');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(ACCOUNT);
    }
  });
});

describe('what the person is told', () => {
  const all: Availability[] = ['ready', 'sleeping', 'waking', 'provisioning', 'stopped', 'plan_required', 'usage_limit', 'plan_ended', 'needs_provider', 'provider_limit', 'error'];

  it('has plain words for every state and no blank title', () => {
    for (const state of all) expect(describeAvailability(state).title.length).toBeGreaterThan(3);
    expect(describeAvailability('sleeping').title).toMatch(/asleep/);
    expect(describeAvailability('usage_limit').detail).toMatch(/renews/);
    expect(describeAvailability('plan_required').detail).toMatch(/plan/);
  });

  it('separates the states that fix themselves from those that need the plan, the period or the service', () => {
    expect(all.filter(isStarting)).toEqual(['waking', 'provisioning', 'provider_limit']);
    expect(all.filter(isBlocked)).toEqual(['plan_required', 'usage_limit', 'plan_ended', 'needs_provider', 'error']);
    expect(isBlocked('sleeping') || isStarting('sleeping')).toBe(false); // asleep: only a wake changes it
    expect(isBlocked('ready') || isStarting('ready')).toBe(false);
  });

  it('explains each failure without a raw code', () => {
    const codes = ['unreachable', 'rate_limited', 'code_invalid', 'no_eligible_workspace', 'session_invalid', 'plan_required', 'usage_limit', 'workspace_not_ready', 'too_many_devices', 'workspace_error', 'server_error'] as const;
    for (const code of codes) {
      const text = describeHostedError(new HostedError(400, code));
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code);
    }
    expect(describeHostedError(new HostedError(429, 'rate_limited', 30))).toContain('30 seconds');
    expect(describeHostedError(new HostedError(403, 'no_eligible_workspace'))).toMatch(/plan/);
  });
});
