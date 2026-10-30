import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { clearCredentials, loadCredentials, saveCredentials } from './credentials';
import { deviceLabel } from './device-label';
import { checkSession, pairDevice, signOutOnServer } from './pairing-api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unpaired' }
  | { status: 'paired'; server: string; token: string; label: string };

type AuthValue = {
  state: AuthState;
  /** Shown on the pairing screen after the server ended this phone's session. */
  notice: string | null;
  /** True from a successful pairing until the person dismisses the note that says what this phone can do. */
  welcome: boolean;
  dismissWelcome: () => void;
  pair: (args: { server: string; code: string }) => Promise<void>;
  signOut: () => Promise<void>;
  /** The server said this phone's token is no longer valid: forget it and go back to pairing. */
  revoked: () => void;
};

const REVOKED_NOTICE = 'Your server signed this phone out. Pair it again to continue.';

// Plain HTTP only in development builds, where the platform also allows it. Release builds are HTTPS only.
export const ALLOW_HTTP = __DEV__;

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadCredentials();
      if (cancelled) return;
      if (!saved) {
        setState({ status: 'unpaired' });
        return;
      }
      setState({ status: 'paired', ...saved });
      // Open straight into the app, then find out in the background whether the server revoked this phone.
      if ((await checkSession(saved.server, saved.token)) === 'revoked' && !cancelled) {
        await clearCredentials();
        setNotice(REVOKED_NOTICE);
        setState({ status: 'unpaired' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pair = useCallback(async ({ server, code }: { server: string; code: string }) => {
    const label = deviceLabel();
    const session = await pairDevice({ server, code, label, allowHttp: ALLOW_HTTP });
    const credentials = { server: session.server, token: session.token, label: session.label ?? label };
    await saveCredentials(credentials);
    setNotice(null);
    setWelcome(true);
    setState({ status: 'paired', ...credentials });
  }, []);

  const signOut = useCallback(async () => {
    if (state.status === 'paired') await signOutOnServer(state.server, state.token);
    await clearCredentials();
    setNotice(null);
    setWelcome(false);
    setState({ status: 'unpaired' });
  }, [state]);

  const revoked = useCallback(() => {
    void clearCredentials();
    setNotice(REVOKED_NOTICE);
    setWelcome(false);
    setState({ status: 'unpaired' });
  }, []);

  const dismissWelcome = useCallback(() => setWelcome(false), []);

  const value = useMemo(() => ({ state, notice, welcome, dismissWelcome, pair, signOut, revoked }), [state, notice, welcome, dismissWelcome, pair, signOut, revoked]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
