// The hosted account's sign-in, kept in the OS secure store apart from the phone's workspace token (which lives in
// `credentials`): the account session may sign in, wake and ask for a workspace token; the workspace token may
// only chat. Never log either, put either in a URL, or copy either anywhere else.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const ACCOUNT_KEY = 'hosted_account';
const INSTALL_KEY = 'hosted_install';

// Kept on this device only: not included in backups or moved to a new phone.
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type HostedAccount = { token: string; email: string; expiresAt: string };

export async function saveHostedAccount(account: HostedAccount): Promise<void> {
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account), OPTIONS);
}

export async function loadHostedAccount(): Promise<HostedAccount | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(ACCOUNT_KEY, OPTIONS);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HostedAccount> | null;
    if (value && typeof value.token === 'string' && value.token && typeof value.email === 'string') {
      return { token: value.token, email: value.email, expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : '' };
    }
  } catch {
    // fall through: a damaged entry counts as signed out
  }
  return null;
}

export async function clearHostedAccount(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCOUNT_KEY, OPTIONS);
}

/**
 * A random id made once for this install and kept across sign-outs, so the service knows a new sign-in is the same
 * phone and replaces its earlier workspace token instead of adding a second phone. It is not a secret and grants
 * nothing by itself.
 */
export async function installId(): Promise<string> {
  try {
    const saved = await SecureStore.getItemAsync(INSTALL_KEY, OPTIONS);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  } catch {
    // fall through and make one
  }
  const fresh = Crypto.randomUUID();
  try {
    await SecureStore.setItemAsync(INSTALL_KEY, fresh, OPTIONS);
  } catch {
    // an id that could not be kept still works for this sign-in
  }
  return fresh;
}
