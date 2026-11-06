// The one place the bearer token is kept: the OS secure store (Keychain on iOS, Keystore-backed on
// Android). Never log it, put it in a URL, or copy it anywhere else.

import * as SecureStore from 'expo-secure-store';

const KEY = 'paired_server';

/**
 * `scopes` is what the server said at pairing, kept so the app can show what this phone may do before it is online.
 * `hosted` is set when this is the phone's own token for the hosted workspace (the account it signed in with); the
 * account's own session is kept apart, in `hosted-credentials`.
 */
export type Credentials = { server: string; token: string; label: string; scopes: string[]; hosted?: { email: string } };

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
      const scopes = Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
      const hosted = value.hosted && typeof value.hosted === 'object' && typeof value.hosted.email === 'string' ? { email: value.hosted.email } : undefined;
      return { server: value.server, token: value.token, label: typeof value.label === 'string' ? value.label : '', scopes, ...(hosted ? { hosted } : {}) };
    }
  } catch {
    // fall through: a damaged entry counts as not paired
  }
  return null;
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
