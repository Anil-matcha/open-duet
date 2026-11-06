import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { clearCredentials, loadCredentials, saveCredentials } from '@/lib/credentials';
import { clearHostedAccount, installId, loadHostedAccount, saveHostedAccount } from '@/lib/hosted-credentials';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => '3f2b8c1e-aaaa-bbbb-cccc-0123456789ab') }));

const store = SecureStore as jest.Mocked<typeof SecureStore>;
const crypto = Crypto as jest.Mocked<typeof Crypto>;
const DEVICE_ONLY = { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' };

beforeEach(() => jest.clearAllMocks());

describe('the workspace token of a hosted phone', () => {
  it('is kept in the same secure entry, marked with the account it signed in with', async () => {
    const credentials = { server: 'https://suparagent.ai', token: 'ods_x', label: 'Pixel', scopes: ['chat'], hosted: { email: 'me@example.com' } };
    await saveCredentials(credentials);
    expect(store.setItemAsync).toHaveBeenCalledWith('paired_server', JSON.stringify(credentials), DEVICE_ONLY);
    store.getItemAsync.mockResolvedValue(JSON.stringify(credentials));
    expect(await loadCredentials()).toEqual(credentials);
  });

  it('leaves a self-hosted entry exactly as it was, with no hosted marker', async () => {
    store.getItemAsync.mockResolvedValue(JSON.stringify({ server: 'https://s', token: 't', label: 'L', scopes: ['chat'] }));
    expect(await loadCredentials()).toEqual({ server: 'https://s', token: 't', label: 'L', scopes: ['chat'] });
  });

  it('ignores a damaged hosted marker rather than treating the phone as hosted', async () => {
    for (const hosted of [null, 'me@example.com', {}, { email: 5 }, []]) {
      store.getItemAsync.mockResolvedValue(JSON.stringify({ server: 'https://s', token: 't', label: 'L', scopes: [], hosted }));
      expect(await loadCredentials()).toEqual({ server: 'https://s', token: 't', label: 'L', scopes: [] });
    }
  });
});

describe('the hosted account session', () => {
  it('is its own secure entry, apart from the workspace token, kept on this device only', async () => {
    await saveHostedAccount({ token: 'odm_x', email: 'me@example.com', expiresAt: '2027-01-01T00:00:00Z' });
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(store.setItemAsync).toHaveBeenCalledWith('hosted_account', JSON.stringify({ token: 'odm_x', email: 'me@example.com', expiresAt: '2027-01-01T00:00:00Z' }), DEVICE_ONLY);
    await clearHostedAccount();
    expect(store.deleteItemAsync).toHaveBeenCalledWith('hosted_account', DEVICE_ONLY);
    await clearCredentials();
    expect(store.deleteItemAsync).toHaveBeenCalledWith('paired_server', DEVICE_ONLY); // the two are cleared separately
  });

  it('loads what was saved, tolerating a missing expiry', async () => {
    store.getItemAsync.mockResolvedValue(JSON.stringify({ token: 'odm_x', email: 'me@example.com', expiresAt: 'later' }));
    expect(await loadHostedAccount()).toEqual({ token: 'odm_x', email: 'me@example.com', expiresAt: 'later' });
    store.getItemAsync.mockResolvedValue(JSON.stringify({ token: 'odm_x', email: 'me@example.com' }));
    expect(await loadHostedAccount()).toEqual({ token: 'odm_x', email: 'me@example.com', expiresAt: '' });
  });

  it('treats a missing, damaged or incomplete entry as signed out', async () => {
    store.getItemAsync.mockResolvedValue(null);
    expect(await loadHostedAccount()).toBeNull();
    store.getItemAsync.mockResolvedValue('not json');
    expect(await loadHostedAccount()).toBeNull();
    store.getItemAsync.mockResolvedValue(JSON.stringify({ token: '', email: 'a@b.co' }));
    expect(await loadHostedAccount()).toBeNull();
    store.getItemAsync.mockResolvedValue(JSON.stringify({ token: 'odm_x' }));
    expect(await loadHostedAccount()).toBeNull();
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    expect(await loadHostedAccount()).toBeNull();
  });
});

describe('installId', () => {
  it('makes a random id once, keeps it, and gives the same one afterwards', async () => {
    store.getItemAsync.mockResolvedValue(null);
    const first = await installId();
    expect(first).toBe('3f2b8c1e-aaaa-bbbb-cccc-0123456789ab');
    expect(store.setItemAsync).toHaveBeenCalledWith('hosted_install', first, DEVICE_ONLY);
    store.getItemAsync.mockResolvedValue(first);
    crypto.randomUUID.mockClear();
    expect(await installId()).toBe(first);
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('matches what the service accepts, and replaces a kept value that does not', async () => {
    expect(await installId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    store.getItemAsync.mockResolvedValue('bad id with spaces!');
    expect(await installId()).toBe('3f2b8c1e-aaaa-bbbb-cccc-0123456789ab');
  });

  it('still works for this sign-in when the secure store cannot keep it', async () => {
    store.getItemAsync.mockRejectedValue(new Error('unavailable'));
    store.setItemAsync.mockRejectedValue(new Error('unavailable'));
    expect(await installId()).toBe('3f2b8c1e-aaaa-bbbb-cccc-0123456789ab');
  });
});
