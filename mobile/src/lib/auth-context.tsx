import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { clearCredentials, loadCredentials, saveCredentials, type Credentials } from './credentials';
import { deviceLabel } from './device-label';
import { createHostedApi, HOSTED_ORIGIN, HostedError, type Platform as HostedPlatform, type Workspace } from './hosted';
import { clearHostedAccount, installId, loadHostedAccount, saveHostedAccount } from './hosted-credentials';
import { connectWorkspace, recoverWorkspaceToken } from './hosted-flow';
import { pairDevice, readSession, signOutOnServer } from './pairing-api';
import { normalizeServerUrl } from './server-url';

/** Set when this phone is signed in to the hosted workspace: the account it used, and the account session. */
export type HostedLink = { email: string; accountToken: string };

export type AuthState =
  | { status: 'loading' }
  | { status: 'unpaired' }
  | { status: 'paired'; server: string; token: string; label: string; scopes: string[]; hosted?: HostedLink };

/** What a hosted sign-in or its continuation ended with. */
export type HostedResult = { kind: 'connected' } | { kind: 'waiting'; workspace: Workspace };

type AuthValue = {
  state: AuthState;
  /** Shown on the pairing screen after the server ended this phone's session. */
  notice: string | null;
  /** True from a successful pairing until the person dismisses the note that says what this phone can do. */
  welcome: boolean;
  dismissWelcome: () => void;
  pair: (args: { server: string; code: string }) => Promise<void>;
  /** Proves the emailed code, then gets this phone its own workspace token, waking the workspace if it sleeps. */
  hostedSignIn: (args: { email: string; code: string; onUpdate?: (workspace: Workspace) => void }) => Promise<HostedResult>;
  /** Carries on a sign-in that stopped because the workspace was not ready, using the account session kept so far. */
  hostedContinue: (args: { onUpdate?: (workspace: Workspace) => void }) => Promise<HostedResult>;
  /** The hosted account session ended (the service said so): forget everything and ask for a new sign-in. */
  hostedEnded: () => void;
  signOut: () => Promise<void>;
  /** The server said this phone's token is no longer valid: forget it and go back to pairing. */
  revoked: () => void;
};

const REVOKED_NOTICE = 'Your server signed this phone out. Pair it again to continue.';

const UNSAFE_NOTICE = 'This phone was paired with a server address the app no longer accepts. Pair it again with an https:// address.';

const HOSTED_ENDED_NOTICE = 'Your hosted sign-in ended. Sign in again to open your workspace.';

/** A phone asks to be given a new workspace token at most this often, so a refusal can never become a loop. */
const RECOVER_EVERY_MS = 30_000;

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

function hostedPlatform(): HostedPlatform {
  return Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : 'other';
}

function scopeOf(scopes: readonly string[]): 'chat' | 'files' {
  return scopes.includes('files') ? 'files' : 'chat';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const recovering = useRef(false);
  const lastRecovery = useRef(0);
  const hosted = useMemo(() => createHostedApi(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadCredentials();
      if (cancelled) return;
      if (!saved) {
        setState({ status: 'unpaired' });
        return;
      }
      // A saved address must pass today's rule (https, or http on this network only); one that does not is forgotten.
      if (!normalizeServerUrl(saved.server).ok) {
        await clearCredentials();
        await clearHostedAccount();
        setNotice(UNSAFE_NOTICE);
        setState({ status: 'unpaired' });
        return;
      }
      if (saved.hosted) {
        // A hosted phone needs its account session as well, to wake the workspace and to get a new token.
        const account = await loadHostedAccount();
        if (cancelled) return;
        if (!account) {
          await clearCredentials();
          setNotice(HOSTED_ENDED_NOTICE);
          setState({ status: 'unpaired' });
          return;
        }
        setState({ status: 'paired', server: saved.server, token: saved.token, label: saved.label, scopes: saved.scopes, hosted: { email: saved.hosted.email, accountToken: account.token } });
        return;
      }
      setState({ status: 'paired', server: saved.server, token: saved.token, label: saved.label, scopes: saved.scopes });
      // Open straight into the app, then find out in the background whether the server revoked this phone.
      const read = await readSession(saved.server, saved.token);
      if (cancelled) return;
      if (read.status === 'revoked') {
        await clearCredentials();
        setNotice(REVOKED_NOTICE);
        setState({ status: 'unpaired' });
      } else if (read.status === 'valid' && read.scopes && read.scopes.join(' ') !== saved.scopes.join(' ')) {
        // The server's word on what this phone may do wins over what was kept at pairing.
        const next = { server: saved.server, token: saved.token, label: saved.label, scopes: read.scopes };
        await saveCredentials(next);
        if (!cancelled) setState({ status: 'paired', ...next });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pair = useCallback(async ({ server, code }: { server: string; code: string }) => {
    const label = deviceLabel();
    const session = await pairDevice({ server, code, label, });
    const credentials = { server: session.server, token: session.token, label: session.label ?? label, scopes: session.scopes };
    await saveCredentials(credentials);
    setNotice(null);
    setWelcome(true);
    setState({ status: 'paired', ...credentials });
  }, []);

  /** Keeps the phone's workspace token and opens the app on it. */
  const finishHosted = useCallback(async (email: string, accountToken: string, grant: { token: string; scopes: string[] }, label: string, firstTime: boolean) => {
    const credentials: Credentials = { server: HOSTED_ORIGIN, token: grant.token, label, scopes: grant.scopes, hosted: { email } };
    await saveCredentials(credentials);
    setNotice(null);
    setWelcome(firstTime);  // the note about what this phone may do is for a new sign-in, not a renewed token
    setState({ status: 'paired', server: credentials.server, token: credentials.token, label, scopes: grant.scopes, hosted: { email, accountToken } });
  }, []);

  const connect = useCallback(
    async (email: string, accountToken: string, onUpdate?: (workspace: Workspace) => void): Promise<HostedResult> => {
      // Opening the app to sign in is the person's own action, so waking a sleeping workspace here is allowed.
      const result = await connectWorkspace(hosted, accountToken, { wake: true, onUpdate });
      if (result.kind === 'not_ready') return { kind: 'waiting', workspace: result.workspace };
      await finishHosted(email, accountToken, result.grant, deviceLabel(), true);
      return { kind: 'connected' };
    },
    [hosted, finishHosted],
  );

  const hostedSignIn = useCallback(
    async ({ email, code, onUpdate }: { email: string; code: string; onUpdate?: (workspace: Workspace) => void }): Promise<HostedResult> => {
      const session = await hosted.verifyEmail({ email, code, deviceId: await installId(), label: deviceLabel(), platform: hostedPlatform() });
      await saveHostedAccount({ token: session.token, email: session.email, expiresAt: session.expiresAt });
      return connect(session.email, session.token, onUpdate);
    },
    [hosted, connect],
  );

  const hostedContinue = useCallback(
    async ({ onUpdate }: { onUpdate?: (workspace: Workspace) => void }): Promise<HostedResult> => {
      const account = await loadHostedAccount();
      if (!account) throw new HostedError(401, 'session_invalid');
      return connect(account.email, account.token, onUpdate);
    },
    [connect],
  );

  const hostedEnded = useCallback(() => {
    void clearCredentials();
    void clearHostedAccount();
    setNotice(HOSTED_ENDED_NOTICE);
    setWelcome(false);
    setState({ status: 'unpaired' });
  }, []);

  const signOut = useCallback(async () => {
    const current = stateRef.current;
    if (current.status === 'paired') {
      if (current.hosted) await hosted.logout(current.hosted.accountToken);
      else await signOutOnServer(current.server, current.token);
    }
    await clearCredentials();
    await clearHostedAccount();
    setNotice(null);
    setWelcome(false);
    setState({ status: 'unpaired' });
  }, [hosted]);

  const revoked = useCallback(() => {
    const current = stateRef.current;
    if (current.status === 'paired' && current.hosted) {
      // The workspace refused this phone's token. If the account sign-in still holds, ask for a new one (only when
      // the workspace is running, and at most every half minute); if it ended too, sign in again.
      const link = current.hosted;
      if (recovering.current || Date.now() - lastRecovery.current < RECOVER_EVERY_MS) return;
      recovering.current = true;
      lastRecovery.current = Date.now();
      void (async () => {
        try {
          const result = await recoverWorkspaceToken(hosted, link.accountToken, scopeOf(current.scopes));
          if (result.kind === 'signed_out') hostedEnded();
          else if (result.kind === 'granted') await finishHosted(link.email, link.accountToken, result.grant, current.label, false);
        } finally {
          recovering.current = false;
        }
      })();
      return;
    }
    void clearCredentials();
    setNotice(REVOKED_NOTICE);
    setWelcome(false);
    setState({ status: 'unpaired' });
  }, [hosted, hostedEnded, finishHosted]);

  const dismissWelcome = useCallback(() => setWelcome(false), []);

  const value = useMemo(
    () => ({ state, notice, welcome, dismissWelcome, pair, hostedSignIn, hostedContinue, hostedEnded, signOut, revoked }),
    [state, notice, welcome, dismissWelcome, pair, hostedSignIn, hostedContinue, hostedEnded, signOut, revoked],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
