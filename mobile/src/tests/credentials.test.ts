import * as SecureStore from 'expo-secure-store';

import { clearCredentials, loadCredentials, saveCredentials } from '@/lib/credentials';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const store = SecureStore as jest.Mocked<typeof SecureStore>;

beforeEach(() => jest.clearAllMocks());

describe('credentials', () => {
  it('saves one JSON entry in the secure store, kept on this device only', async () => {
    await saveCredentials({ server: 'https://dots.example.com', token: 'ods_x', label: 'My phone' });
    expect(store.setItemAsync).toHaveBeenCalledWith(
      'paired_server',
      JSON.stringify({ server: 'https://dots.example.com', token: 'ods_x', label: 'My phone' }),
      { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
    );
  });

  it('loads what was saved', async () => {
    store.getItemAsync.mockResolvedValue(JSON.stringify({ server: 'https://s', token: 't', label: 'L' }));
    expect(await loadCredentials()).toEqual({ server: 'https://s', token: 't', label: 'L' });
  });

  it('treats a missing, damaged or incomplete entry as not paired', async () => {
    store.getItemAsync.mockResolvedValue(null);
    expect(await loadCredentials()).toBeNull();
    store.getItemAsync.mockResolvedValue('not json');
    expect(await loadCredentials()).toBeNull();
    store.getItemAsync.mockResolvedValue(JSON.stringify({ server: 'https://s' }));
    expect(await loadCredentials()).toBeNull();
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    expect(await loadCredentials()).toBeNull();
  });

  it('clears the entry', async () => {
    await clearCredentials();
    expect(store.deleteItemAsync).toHaveBeenCalledWith('paired_server', { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
  });
});
