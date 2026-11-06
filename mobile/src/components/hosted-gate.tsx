import { usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { useAuth } from '@/lib/auth-context';
import { createHostedApi, describeAvailability, HOSTED_ORIGIN, HostedError, isBlocked, isStarting, type Availability, type Workspace } from '@/lib/hosted';
import { SIGNAL_MS, waitForWorkspace } from '@/lib/hosted-flow';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';
import { WorkspaceContext, type WorkspaceSignals } from '@/lib/workspace-context';

/** A 503 found while the app is open is looked at again no more often than this. */
const RECHECK_MS = 10_000;

/**
 * Stands between a phone signed in to the hosted workspace and the app: the app shows only while the workspace is
 * ready. When the app opens (or comes back to the front) it looks, and wakes a sleeping workspace once, because the
 * person has just opened it. A blocked state (plan ended, hours used up) is shown and never retried by itself. While
 * a conversation is on screen it tells the service the workspace is in use. A self-hosted phone passes straight through.
 */
export function HostedGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const accountToken = state.status === 'paired' ? state.hosted?.accountToken : undefined;
  if (!accountToken) return <>{children}</>;
  return <ActiveGate accountToken={accountToken}>{children}</ActiveGate>;
}

function ActiveGate({ accountToken, children }: { accountToken: string; children: ReactNode }) {
  const { signOut, hostedEnded } = useAuth();
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const api = useMemo(() => createHostedApi(), []);
  const tokenRef = useRef(accountToken);
  useEffect(() => {
    tokenRef.current = accountToken;
  }, [accountToken]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [failed, setFailed] = useState(false);
  const [everReady, setEverReady] = useState(false);
  const generation = useRef(0);
  const lastRecheck = useRef(0);
  const [signingOut, setSigningOut] = useState(false);

  const settle = useCallback((workspace: Workspace) => {
    setFailed(false);
    setAvailability(workspace.availability);
    if (workspace.availability === 'ready') setEverReady(true);
  }, []);

  /** Looks at the workspace; with `wake`, also wakes it once if it is asleep. A newer look replaces an older one. */
  const look = useCallback(
    async (wake: boolean) => {
      const mine = ++generation.current;
      try {
        const workspace = await waitForWorkspace(api, tokenRef.current, {
          wake,
          onUpdate: (update) => {
            if (mine === generation.current) settle(update);
          },
          isCancelled: () => mine !== generation.current,
        });
        if (mine === generation.current) settle(workspace);
      } catch (error) {
        if (mine !== generation.current) return;
        if (error instanceof HostedError && error.code === 'session_invalid') hostedEnded();
        else setFailed(true);
      }
    },
    [api, settle, hostedEnded],
  );

  // Opening the app, and coming back to it, is the person's own action: look, and wake a sleeping workspace.
  useEffect(() => {
    void look(true);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void look(true);
    });
    return () => {
      generation.current += 1;
      subscription.remove();
    };
  }, [look]);

  // A call found the workspace gone (503) while the app was open: read its state, and wake nothing.
  const signals = useMemo<WorkspaceSignals>(
    () => ({
      unavailable: () => {
        if (Date.now() - lastRecheck.current < RECHECK_MS) return;
        lastRecheck.current = Date.now();
        void look(false);
      },
    }),
    [look],
  );

  // Someone is looking at a conversation: say so, now and every couple of minutes, only while the app is in front.
  const pathname = usePathname();
  const reading = pathname.startsWith('/thread/') || pathname.startsWith('/rooms/');
  const ready = availability === 'ready';
  useEffect(() => {
    if (!ready || !reading) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const send = () => {
      api.signalActive(tokenRef.current).catch((error) => {
        if (error instanceof HostedError && error.code === 'session_invalid') hostedEnded();
      });
    };
    const start = () => {
      if (timer) return;
      send();
      timer = setInterval(send, SIGNAL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const subscription = AppState.addEventListener('change', (next) => (next === 'active' ? start() : stop()));
    return () => {
      stop();
      subscription.remove();
    };
  }, [api, ready, reading, hostedEnded]);

  const leave = async () => {
    setSigningOut(true);
    await signOut();
  };

  const describe = availability ? describeAvailability(availability) : { title: 'Opening your workspace', detail: '' };
  const blocked = availability !== null && isBlocked(availability);
  const asleep = availability === 'sleeping' || availability === 'stopped';
  const busy = !failed && !blocked && !asleep && !ready;

  return (
    <WorkspaceContext.Provider value={signals}>
      {everReady ? children : null}
      {ready ? null : (
        <View style={styles.cover} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.title}>
            {failed ? 'Cannot reach your workspace' : describe.title}
          </Text>
          <Text style={styles.detail}>{failed ? 'Check your connection and try again.' : describe.detail}</Text>
          {busy || (availability !== null && isStarting(availability)) ? <ActivityIndicator style={styles.spinner} color={theme.accent} accessibilityLabel="Working" /> : null}
          {asleep ? (
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={() => void look(true)}>
              <Text style={styles.primaryText}>Wake my workspace</Text>
            </Pressable>
          ) : null}
          {failed ? (
            <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={() => void look(true)}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          ) : null}
          {blocked && !failed ? (
            <>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={() => void look(false)}>
                <Text style={styles.primaryText}>Check again</Text>
              </Pressable>
              <Pressable accessibilityRole="link" style={styles.secondary} onPress={() => void Linking.openURL(`${HOSTED_ORIGIN}/account/billing`)}>
                <Text style={styles.secondaryText}>Open plan and billing</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable accessibilityRole="button" style={[styles.secondary, signingOut && styles.disabled]} disabled={signingOut} onPress={() => void leave()}>
            <Text style={styles.secondaryText}>Sign out</Text>
          </Pressable>
        </View>
      )}
    </WorkspaceContext.Provider>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: p.background, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
    title: { fontSize: 22, fontWeight: '700', color: p.text, textAlign: 'center' },
    detail: { fontSize: 15, color: p.muted, textAlign: 'center' },
    spinner: { marginVertical: 8 },
    primary: { minHeight: touch.min + 4, alignSelf: 'stretch', justifyContent: 'center', alignItems: 'center', backgroundColor: p.accent, borderRadius: radius.field, marginTop: 8 },
    primaryText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    secondary: { minHeight: touch.min, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
    secondaryText: { color: p.accentText, fontSize: 15, fontWeight: '500' },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
  });
