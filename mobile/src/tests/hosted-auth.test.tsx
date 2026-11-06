import { act, render } from '@testing-library/react-native';
import { useEffect } from 'react';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { HostedError, type Availability, type Workspace } from '@/lib/hosted';

const mockLoadCredentials = jest.fn();
const mockSaveCredentials = jest.fn(async (_value: unknown) => undefined);
const mockClearCredentials = jest.fn(async () => undefined);
const mockLoadAccount = jest.fn();
const mockSaveAccount = jest.fn(async (_value: unknown) => undefined);
const mockClearAccount = jest.fn(async () => undefined);
const mockReadSession = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
const mockSignOutOnServer = jest.fn(async (..._args: unknown[]) => true);
const mockApi = { verifyEmail: jest.fn(), logout: jest.fn(), status: jest.fn(), wake: jest.fn(), createDevice: jest.fn(), session: jest.fn() };

jest.mock('@/lib/credentials', () => ({
  loadCredentials: () => mockLoadCredentials(),
  saveCredentials: (value: unknown) => mockSaveCredentials(value),
  clearCredentials: () => mockClearCredentials(),
}));
jest.mock('@/lib/hosted-credentials', () => ({
  loadHostedAccount: () => mockLoadAccount(),
  saveHostedAccount: (value: unknown) => mockSaveAccount(value),
  clearHostedAccount: () => mockClearAccount(),
  installId: async () => 'install-abcdef12',
}));
jest.mock('@/lib/pairing-api', () => ({
  pairDevice: jest.fn(),
  readSession: (...args: unknown[]) => mockReadSession(...args),
  signOutOnServer: (...args: unknown[]) => mockSignOutOnServer(...args),
}));
jest.mock('@/lib/device-label', () => ({ deviceLabel: () => 'Pixel 8' }));
jest.mock('@/lib/hosted', () => ({ ...jest.requireActual('@/lib/hosted'), createHostedApi: () => mockApi }));

const ws = (availability: Availability): Workspace => ({ plan: 'starter', availability, retryAfter: null });
const GRANT = { token: 'ods_' + 'n'.repeat(43), scopes: ['chat'], expiresAt: 'x', baseUrl: 'https://suparagent.ai' };
const SESSION = { token: 'odm_' + 'a'.repeat(43), email: 'me@example.com', expiresAt: '2027-01-01T00:00:00Z', workspace: ws('ready') };
const SAVED_HOSTED = { server: 'https://suparagent.ai', token: 'ods_old', label: 'Pixel 8', scopes: ['chat'], hosted: { email: 'me@example.com' } };
const ACCOUNT = { token: SESSION.token, email: 'me@example.com', expiresAt: '' };

let auth: ReturnType<typeof useAuth>;
function Probe() {
  const value = useAuth();
  // Kept for the test to call; set in an effect, not while rendering.
  useEffect(() => {
    auth = value;
  });
  return null;
}

const flush = () => act(async () => {});
async function mount() {
  await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await flush();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadCredentials.mockReset().mockResolvedValue(null);
  mockLoadAccount.mockReset().mockResolvedValue(null);
  mockReadSession.mockReset().mockResolvedValue({ status: 'valid', scopes: ['chat'] });
  mockApi.verifyEmail.mockReset().mockResolvedValue(SESSION);
  mockApi.logout.mockReset().mockResolvedValue(true);
  mockApi.status.mockReset().mockResolvedValue(ws('ready'));
  mockApi.wake.mockReset().mockResolvedValue(ws('waking'));
  mockApi.createDevice.mockReset().mockResolvedValue(GRANT);
  mockApi.session.mockReset().mockResolvedValue({ email: 'me@example.com', expiresAt: 'x', workspace: null });
});

describe('opening the app', () => {
  it('keeps a self-hosted phone as it was: paired, and checked against its own server', async () => {
    mockLoadCredentials.mockResolvedValue({ server: 'https://dots.example.com', token: 'ods_s', label: 'Pixel', scopes: ['chat'] });
    await mount();
    expect(auth.state).toEqual({ status: 'paired', server: 'https://dots.example.com', token: 'ods_s', label: 'Pixel', scopes: ['chat'] });
    expect(mockReadSession).toHaveBeenCalledWith('https://dots.example.com', 'ods_s');
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('opens a hosted phone with its account session, and does not ask its own server about it', async () => {
    mockLoadCredentials.mockResolvedValue(SAVED_HOSTED);
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
    expect(auth.state).toEqual({
      status: 'paired', server: 'https://suparagent.ai', token: 'ods_old', label: 'Pixel 8', scopes: ['chat'],
      hosted: { email: 'me@example.com', accountToken: SESSION.token },
    });
    expect(mockReadSession).not.toHaveBeenCalled();
  });

  it('signs a hosted phone out when its account session is missing, with a plain note', async () => {
    mockLoadCredentials.mockResolvedValue(SAVED_HOSTED);
    await mount();
    expect(auth.state.status).toBe('unpaired');
    expect(mockClearCredentials).toHaveBeenCalled();
    expect(auth.notice).toMatch(/hosted sign-in ended/);
  });
});

describe('signing in to the hosted workspace', () => {
  it('proves the code with this install’s id, name and platform, keeps both tokens apart, and opens the app', async () => {
    await mount();
    let result: unknown;
    await act(async () => {
      result = await auth.hostedSignIn({ email: 'me@example.com', code: '123456' });
    });
    expect(result).toEqual({ kind: 'connected' });
    expect(mockApi.verifyEmail).toHaveBeenCalledWith({ email: 'me@example.com', code: '123456', deviceId: 'install-abcdef12', label: 'Pixel 8', platform: expect.stringMatching(/^(android|ios|other)$/) });
    expect(mockSaveAccount).toHaveBeenCalledWith({ token: SESSION.token, email: 'me@example.com', expiresAt: SESSION.expiresAt });
    expect(mockSaveCredentials).toHaveBeenCalledWith({ server: 'https://suparagent.ai', token: GRANT.token, label: 'Pixel 8', scopes: ['chat'], hosted: { email: 'me@example.com' } });
    expect(auth.state).toEqual({ status: 'paired', server: 'https://suparagent.ai', token: GRANT.token, label: 'Pixel 8', scopes: ['chat'], hosted: { email: 'me@example.com', accountToken: SESSION.token } });
    expect(auth.welcome).toBe(true);
    // The account token is never the workspace token, and each is stored once.
    expect(JSON.stringify(mockSaveCredentials.mock.calls)).not.toContain(SESSION.token);
    expect(JSON.stringify(mockSaveAccount.mock.calls)).not.toContain(GRANT.token);
  });

  it('wakes a sleeping workspace as part of signing in, because the person is signing in', async () => {
    mockApi.status.mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready'));
    mockApi.wake.mockResolvedValue(ws('ready'));
    await mount();
    await act(async () => {
      await auth.hostedSignIn({ email: 'me@example.com', code: '123456' });
    });
    expect(mockApi.wake).toHaveBeenCalledTimes(1);
    expect(auth.state.status).toBe('paired');
  });

  it('reports progress while the workspace starts', async () => {
    mockApi.status.mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready'));
    mockApi.wake.mockResolvedValue(ws('ready'));
    await mount();
    const seen: Availability[] = [];
    await act(async () => {
      await auth.hostedSignIn({ email: 'me@example.com', code: '123456', onUpdate: (w) => seen.push(w.availability) });
    });
    expect(seen[0]).toBe('sleeping');
    expect(seen[seen.length - 1]).toBe('ready');
  });

  it('keeps the account session but does not open the app when the workspace is blocked, and says why', async () => {
    mockApi.status.mockResolvedValue(ws('usage_limit'));
    await mount();
    let result: unknown;
    await act(async () => {
      result = await auth.hostedSignIn({ email: 'me@example.com', code: '123456' });
    });
    expect(result).toEqual({ kind: 'waiting', workspace: ws('usage_limit') });
    expect(mockSaveAccount).toHaveBeenCalledTimes(1);
    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(mockApi.createDevice).not.toHaveBeenCalled();
    expect(auth.state.status).toBe('unpaired');
  });

  it('stores nothing when the code is refused', async () => {
    mockApi.verifyEmail.mockRejectedValue(new HostedError(401, 'code_invalid'));
    await mount();
    await act(async () => {
      await expect(auth.hostedSignIn({ email: 'me@example.com', code: '000000' })).rejects.toMatchObject({ code: 'code_invalid' });
    });
    expect(mockSaveAccount).not.toHaveBeenCalled();
    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(auth.state.status).toBe('unpaired');
  });

  it('carries on a sign-in that stopped halfway, from the account session it kept', async () => {
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
    await act(async () => {
      expect(await auth.hostedContinue({})).toEqual({ kind: 'connected' });
    });
    expect(mockApi.verifyEmail).not.toHaveBeenCalled();
    expect(mockApi.status).toHaveBeenCalledWith(SESSION.token);
    expect(auth.state.status).toBe('paired');
  });

  it('cannot carry on without an account session', async () => {
    await mount();
    await act(async () => {
      await expect(auth.hostedContinue({})).rejects.toMatchObject({ code: 'session_invalid' });
    });
  });
});

describe('signing out', () => {
  async function hostedPhone() {
    mockLoadCredentials.mockResolvedValue(SAVED_HOSTED);
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
  }

  it('ends the hosted sign-in on the service and forgets both tokens', async () => {
    await hostedPhone();
    await act(async () => auth.signOut());
    expect(mockApi.logout).toHaveBeenCalledWith(SESSION.token);
    expect(mockSignOutOnServer).not.toHaveBeenCalled();
    expect(mockClearCredentials).toHaveBeenCalled();
    expect(mockClearAccount).toHaveBeenCalled();
    expect(auth.state.status).toBe('unpaired');
  });

  it('forgets everything even when the service cannot be reached', async () => {
    mockApi.logout.mockResolvedValue(false);
    await hostedPhone();
    await act(async () => auth.signOut());
    expect(mockClearCredentials).toHaveBeenCalled();
    expect(mockClearAccount).toHaveBeenCalled();
    expect(auth.state.status).toBe('unpaired');
  });

  it('signs a server phone out on its own server, as before', async () => {
    mockLoadCredentials.mockResolvedValue({ server: 'https://dots.example.com', token: 'ods_s', label: 'Pixel', scopes: ['chat'] });
    await mount();
    await act(async () => auth.signOut());
    expect(mockSignOutOnServer).toHaveBeenCalledWith('https://dots.example.com', 'ods_s');
    expect(mockApi.logout).not.toHaveBeenCalled();
  });

  it('asks for a new sign-in, with a note, when the service says the hosted session ended', async () => {
    await hostedPhone();
    await act(async () => auth.hostedEnded());
    expect(auth.state.status).toBe('unpaired');
    expect(auth.notice).toMatch(/hosted sign-in ended/);
    expect(mockClearCredentials).toHaveBeenCalled();
    expect(mockClearAccount).toHaveBeenCalled();
  });
});

describe('when the workspace refuses this phone’s token', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  async function hostedPhone() {
    mockLoadCredentials.mockResolvedValue(SAVED_HOSTED);
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
  }

  it('gets a new token when the account sign-in holds and the workspace is running, without a welcome note', async () => {
    await hostedPhone();
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.session).toHaveBeenCalledWith(SESSION.token);
    expect(mockApi.createDevice).toHaveBeenCalledWith(SESSION.token, 'chat');
    expect(mockSaveCredentials).toHaveBeenCalledWith(expect.objectContaining({ token: GRANT.token, hosted: { email: 'me@example.com' } }));
    expect(auth.state).toMatchObject({ status: 'paired', token: GRANT.token });
    expect(auth.welcome).toBe(false);
  });

  it('asks for the same scope the phone had', async () => {
    mockLoadCredentials.mockResolvedValue({ ...SAVED_HOSTED, scopes: ['chat', 'files'] });
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.createDevice).toHaveBeenCalledWith(SESSION.token, 'files');
  });

  it('does not wake the workspace to do it, and keeps the phone signed in', async () => {
    mockApi.status.mockResolvedValue(ws('sleeping'));
    await hostedPhone();
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.wake).not.toHaveBeenCalled();
    expect(mockApi.createDevice).not.toHaveBeenCalled();
    expect(auth.state.status).toBe('paired');
  });

  it('signs the person out when the account sign-in ended too', async () => {
    mockApi.session.mockRejectedValue(new HostedError(401, 'session_invalid'));
    await hostedPhone();
    await act(async () => auth.revoked());
    await flush();
    expect(auth.state.status).toBe('unpaired');
    expect(auth.notice).toMatch(/hosted sign-in ended/);
    expect(mockClearAccount).toHaveBeenCalled();
  });

  it('tries at most once every half minute, however often the app reports a refusal', async () => {
    mockApi.status.mockResolvedValue(ws('sleeping'));
    await hostedPhone();
    await act(async () => {
      auth.revoked();
      auth.revoked();
      auth.revoked();
    });
    await flush();
    expect(mockApi.session).toHaveBeenCalledTimes(1);
    now += 10_000;
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.session).toHaveBeenCalledTimes(1);
    now += 25_000;
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.session).toHaveBeenCalledTimes(2);
  });

  it('still forgets a server phone straight away, with the old note', async () => {
    mockLoadCredentials.mockResolvedValue({ server: 'https://dots.example.com', token: 'ods_s', label: 'Pixel', scopes: ['chat'] });
    await mount();
    await act(async () => auth.revoked());
    expect(auth.state.status).toBe('unpaired');
    expect(auth.notice).toMatch(/Your server signed this phone out/);
    expect(mockApi.session).not.toHaveBeenCalled();
  });
});

describe('file access on a hosted phone', () => {
  async function hostedPhone(scopes: string[] = ['chat']) {
    mockLoadCredentials.mockResolvedValue({ ...SAVED_HOSTED, scopes });
    mockLoadAccount.mockResolvedValue(ACCOUNT);
    await mount();
  }

  it('asks for a files token with the account session, keeps it, and shows no welcome note', async () => {
    await hostedPhone();
    mockApi.createDevice.mockResolvedValue({ ...GRANT, token: 'ods_' + 'f'.repeat(43), scopes: ['chat', 'files'] });
    await act(async () => auth.hostedSetFiles(true));
    expect(mockApi.createDevice).toHaveBeenCalledWith(SESSION.token, 'files');
    expect(mockSaveCredentials).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['chat', 'files'], hosted: { email: 'me@example.com' } }));
    expect(auth.state).toMatchObject({ status: 'paired', token: 'ods_' + 'f'.repeat(43), scopes: ['chat', 'files'] });
    expect(auth.welcome).toBe(false);
  });

  it('goes back to chat only by asking for a chat token', async () => {
    await hostedPhone(['chat', 'files']);
    await act(async () => auth.hostedSetFiles(false));
    expect(mockApi.createDevice).toHaveBeenCalledWith(SESSION.token, 'chat');
    expect(auth.state).toMatchObject({ scopes: ['chat'] });
  });

  it('never wakes the workspace and never reads its status to do it', async () => {
    await hostedPhone();
    await act(async () => auth.hostedSetFiles(true));
    expect(mockApi.wake).not.toHaveBeenCalled();
    expect(mockApi.status).not.toHaveBeenCalled();
  });

  it('keeps the old token and says so when the workspace is not running', async () => {
    await hostedPhone();
    mockApi.createDevice.mockRejectedValue(new HostedError(409, 'workspace_not_ready'));
    await act(async () => {
      await expect(auth.hostedSetFiles(true)).rejects.toMatchObject({ code: 'workspace_not_ready' });
    });
    expect(mockSaveCredentials).not.toHaveBeenCalled();
    expect(auth.state).toMatchObject({ token: 'ods_old', scopes: ['chat'] });
  });

  it('asks for a new sign-in when the account session has ended', async () => {
    await hostedPhone();
    mockApi.createDevice.mockRejectedValue(new HostedError(401, 'session_invalid'));
    await act(async () => {
      await expect(auth.hostedSetFiles(true)).rejects.toBeInstanceOf(HostedError);
    });
    expect(auth.state.status).toBe('unpaired');
    expect(auth.notice).toMatch(/hosted sign-in ended/);
  });

  it('does nothing for a phone paired to a server', async () => {
    mockLoadCredentials.mockResolvedValue({ server: 'https://dots.example.com', token: 'ods_s', label: 'Pixel', scopes: ['chat'] });
    await mount();
    await act(async () => auth.hostedSetFiles(true));
    expect(mockApi.createDevice).not.toHaveBeenCalled();
  });

  it('keeps files after a token renewal', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await hostedPhone(['chat', 'files']);
    await act(async () => auth.revoked());
    await flush();
    expect(mockApi.createDevice).toHaveBeenCalledWith(SESSION.token, 'files');
    jest.restoreAllMocks();
  });
});
