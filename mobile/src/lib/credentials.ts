// The one place the bearer token is kept: the OS secure store (Keychain on iOS, Keystore-backed on
// Android). Never log it, put it in a URL, or copy it anywhere else.

import * as SecureStore from 'expo-secure-store';

const KEY = 'paired_server';

export type Credentials = { server: string; token: string; label: string };

// Kept on this device only: not included in backups or moved to a new phone.
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(credentials), OPTIONS);
}

export async function loadCredentials(): Promise<Credentials | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credentials> | null;
    if (value && typeof value.server === 'string' && typeof value.token === 'string' && value.server && value.token) {
      return { server: value.server, token: value.token, label: typeof value.label === 'string' ? value.label : '' };
    }
  } catch {
    // fall through: a damaged entry counts as not paired
  }
  return null;
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
