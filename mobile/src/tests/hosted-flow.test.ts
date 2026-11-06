import { HostedError, type Availability, type HostedApi, type Workspace } from '@/lib/hosted';
import { connectWorkspace, GIVE_UP_MS, MAX_FAILED_READS, POLL_MS, recoverWorkspaceToken, waitForWorkspace } from '@/lib/hosted-flow';

const TOKEN = 'odm_' + 'a'.repeat(43);
const GRANT = { token: 'ods_' + 'b'.repeat(43), scopes: ['chat'], expiresAt: 'x', baseUrl: 'https://suparagent.ai' };

const ws = (availability: Availability, retryAfter: number | null = null): Workspace => ({ plan: 'starter', availability, retryAfter });

/** A fake service: `reads` are what successive status reads answer (the last repeats); calls are recorded. */
function fakeApi(reads: (Workspace | Error)[], extra: Partial<Record<'wake' | 'createDevice' | 'session', jest.Mock>> = {}) {
  let n = 0;
  const status = jest.fn(async () => {
    const next = reads[Math.min(n++, reads.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  const api = {
    status,
    wake: extra.wake ?? jest.fn(async () => ws('waking')),
    createDevice: extra.createDevice ?? jest.fn(async () => GRANT),
    session: extra.session ?? jest.fn(async () => ({ email: 'a@b.co', expiresAt: 'x', workspace: null })),
  };
  return { api: api as unknown as HostedApi, ...api };
}

function clock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('waitForWorkspace', () => {
  it('returns at once when the workspace is ready, and starts nothing', async () => {
    const f = fakeApi([ws('ready')]);
    expect((await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep })).availability).toBe('ready');
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenCalledTimes(1);
  });

  it('wakes a sleeping workspace once, then looks only while it starts', async () => {
    const f = fakeApi([ws('sleeping'), ws('waking'), ws('waking'), ws('ready')]);
    const c = clock();
    const seen: Availability[] = [];
    const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep, onUpdate: (w) => seen.push(w.availability) });
    expect(result.availability).toBe('ready');
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect(f.status).toHaveBeenCalledTimes(4); // the first look, then three while it starts
    expect(c.waits).toEqual([POLL_MS, POLL_MS, POLL_MS]);
    expect(seen).toEqual(['sleeping', 'waking', 'waking', 'waking', 'ready']);
  });

  it('only reads when it was not asked to wake', async () => {
    const f = fakeApi([ws('sleeping')]);
    expect((await waitForWorkspace(f.api, TOKEN, { wake: false, sleep: clock().sleep })).availability).toBe('sleeping');
    expect(f.wake).not.toHaveBeenCalled();
    const stopped = fakeApi([ws('stopped')]);
    expect((await waitForWorkspace(stopped.api, TOKEN, { wake: false, sleep: clock().sleep })).availability).toBe('stopped');
  });

  it('never wakes, polls or retries a blocked state', async () => {
    for (const state of ['plan_required', 'usage_limit', 'plan_ended', 'needs_provider', 'error'] as const) {
      const f = fakeApi([ws(state)]);
      const c = clock();
      expect((await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep })).availability).toBe(state);
      expect(f.wake).not.toHaveBeenCalled();
      expect(f.status).toHaveBeenCalledTimes(1);
      expect(c.waits).toEqual([]);
    }
  });

  it('reads the service’s 402 on a status read as a blocked state, without waking or polling', async () => {
    for (const code of ['plan_required', 'usage_limit'] as const) {
      const f = fakeApi([new HostedError(402, code)]);
      const c = clock();
      const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep });
      expect(result.availability).toBe(code);
      expect(f.wake).not.toHaveBeenCalled();
      expect(f.status).toHaveBeenCalledTimes(1);
      expect(c.waits).toEqual([]);
    }
  });

  it('also reads a 402 that comes while it is waiting for the workspace to start', async () => {
    const f = fakeApi([ws('sleeping'), new HostedError(402, 'usage_limit')]);
    const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result.availability).toBe('usage_limit');
    expect(f.status).toHaveBeenCalledTimes(2);
  });

  it('stops when the wake itself is refused for the plan or the hours', async () => {
    for (const code of ['plan_required', 'usage_limit'] as const) {
      const f = fakeApi([ws('sleeping')], { wake: jest.fn(async () => { throw new HostedError(402, code); }) });
      const c = clock();
      const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep });
      expect(result.availability).toBe(code);
      expect(c.waits).toEqual([]); // no retry loop
    }
  });

  it('leaves another failure of the wake to the caller', async () => {
    const f = fakeApi([ws('sleeping')], { wake: jest.fn(async () => { throw new HostedError(0, 'unreachable'); }) });
    await expect(waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('does not wake a workspace again if it falls asleep while starting', async () => {
    const f = fakeApi([ws('sleeping'), ws('waking'), ws('sleeping')]);
    const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result.availability).toBe('sleeping');
    expect(f.wake).toHaveBeenCalledTimes(1); // the person decides what next
  });

  it('honours a longer wait the service asks for', async () => {
    const f = fakeApi([ws('waking', 20), ws('ready')]);
    const c = clock();
    await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep });
    expect(c.waits).toEqual([20_000]);
  });

  it('gives up after the time limit instead of waiting for ever', async () => {
    const f = fakeApi([ws('waking')]);
    const c = clock();
    const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: c.sleep });
    expect(result.availability).toBe('error');
    expect(c.waits.reduce((a, b) => a + b, 0)).toBe(GIVE_UP_MS);
  });

  it('gives up after a run of failed reads, and a good read in between starts the count again', async () => {
    const bad = new HostedError(0, 'unreachable');
    const f = fakeApi([ws('waking'), ...Array(MAX_FAILED_READS - 1).fill(bad), ws('waking'), ...Array(MAX_FAILED_READS).fill(bad)]);
    const result = await waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result.availability).toBe('error');
    expect(f.status).toHaveBeenCalledTimes(1 + (MAX_FAILED_READS - 1) + 1 + MAX_FAILED_READS);
  });

  it('passes a sign-in that ended up to the caller', async () => {
    const f = fakeApi([new HostedError(401, 'session_invalid')]);
    await expect(waitForWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep })).rejects.toMatchObject({ code: 'session_invalid' });
    const midway = fakeApi([ws('waking'), new HostedError(401, 'session_invalid')]);
    await expect(waitForWorkspace(midway.api, TOKEN, { wake: true, sleep: clock().sleep })).rejects.toMatchObject({ code: 'session_invalid' });
  });

  it('stops looking once it is cancelled', async () => {
    const f = fakeApi([ws('waking')]);
    let cancelled = false;
    const c = clock();
    const result = await waitForWorkspace(f.api, TOKEN, {
      wake: true,
      sleep: async (ms) => {
        c.waits.push(ms);
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    expect(result.availability).toBe('waking');
    expect(f.status).toHaveBeenCalledTimes(1);
  });
});

describe('connectWorkspace', () => {
  it('gets the phone its own token once the workspace is ready, asking for chat only by default', async () => {
    const f = fakeApi([ws('ready')]);
    const result = await connectWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result).toEqual({ kind: 'granted', grant: GRANT, workspace: ws('ready') });
    expect(f.createDevice).toHaveBeenCalledWith(TOKEN, 'chat');
    const files = fakeApi([ws('ready')]);
    await connectWorkspace(files.api, TOKEN, { wake: true, scope: 'files', sleep: clock().sleep });
    expect(files.createDevice).toHaveBeenCalledWith(TOKEN, 'files');
  });

  it('does not ask for a token while the workspace is not ready', async () => {
    for (const state of ['sleeping', 'plan_required', 'usage_limit'] as const) {
      const f = fakeApi([ws(state)]);
      const result = await connectWorkspace(f.api, TOKEN, { wake: false, sleep: clock().sleep });
      expect(result).toEqual({ kind: 'not_ready', workspace: ws(state) });
      expect(f.createDevice).not.toHaveBeenCalled();
    }
  });

  it('waits again if the workspace slipped back to sleep before the token was made', async () => {
    const createDevice = jest.fn().mockRejectedValueOnce(new HostedError(409, 'workspace_not_ready')).mockResolvedValue(GRANT);
    const f = fakeApi([ws('ready')], { createDevice });
    const result = await connectWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result.kind).toBe('granted');
    expect(createDevice).toHaveBeenCalledTimes(2);
  });

  it('gives up after three tries rather than looping', async () => {
    const createDevice = jest.fn().mockRejectedValue(new HostedError(409, 'workspace_not_ready'));
    const f = fakeApi([ws('ready')], { createDevice });
    const result = await connectWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep });
    expect(result).toMatchObject({ kind: 'not_ready', workspace: { availability: 'error' } });
    expect(createDevice).toHaveBeenCalledTimes(3);
  });

  it('reports a plan or hours block from the grant as blocked, and passes other failures on', async () => {
    for (const code of ['plan_required', 'usage_limit'] as const) {
      const f = fakeApi([ws('ready')], { createDevice: jest.fn().mockRejectedValue(new HostedError(402, code)) });
      expect(await connectWorkspace(f.api, TOKEN, { wake: true, sleep: clock().sleep })).toMatchObject({ kind: 'not_ready', workspace: { availability: code } });
    }
    const tooMany = fakeApi([ws('ready')], { createDevice: jest.fn().mockRejectedValue(new HostedError(409, 'too_many_devices')) });
    await expect(connectWorkspace(tooMany.api, TOKEN, { wake: true, sleep: clock().sleep })).rejects.toMatchObject({ code: 'too_many_devices' });
  });
});

describe('recoverWorkspaceToken', () => {
  it('asks for a new token when the sign-in holds and the workspace is running', async () => {
    const f = fakeApi([ws('ready')]);
    expect(await recoverWorkspaceToken(f.api, TOKEN, 'files')).toEqual({ kind: 'granted', grant: GRANT });
    expect(f.createDevice).toHaveBeenCalledWith(TOKEN, 'files');
  });

  it('never wakes the workspace to do it', async () => {
    for (const state of ['sleeping', 'waking', 'usage_limit'] as const) {
      const f = fakeApi([ws(state)]);
      expect(await recoverWorkspaceToken(f.api, TOKEN)).toEqual({ kind: 'later', workspace: ws(state) });
      expect(f.wake).not.toHaveBeenCalled();
      expect(f.createDevice).not.toHaveBeenCalled();
    }
  });

  it('signs the person out when the account sign-in ended too', async () => {
    const f = fakeApi([ws('ready')], { session: jest.fn().mockRejectedValue(new HostedError(401, 'session_invalid')) });
    expect(await recoverWorkspaceToken(f.api, TOKEN)).toEqual({ kind: 'signed_out' });
    expect(f.createDevice).not.toHaveBeenCalled();
  });

  it('tries again later on any other failure, without signing out', async () => {
    const f = fakeApi([ws('ready')], { session: jest.fn().mockRejectedValue(new HostedError(0, 'unreachable')) });
    expect(await recoverWorkspaceToken(f.api, TOKEN)).toEqual({ kind: 'later', workspace: null });
    const g = fakeApi([ws('ready')], { createDevice: jest.fn().mockRejectedValue(new HostedError(409, 'too_many_devices')) });
    expect(await recoverWorkspaceToken(g.api, TOKEN)).toEqual({ kind: 'later', workspace: null });
  });
});
