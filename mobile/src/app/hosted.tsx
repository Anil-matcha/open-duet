import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { KeyboardScreen } from '@/components/keyboard-screen';
import { Text, TextInput } from '@/components/text';
import { useAuth } from '@/lib/auth-context';
import { createHostedApi, describeAvailability, describeHostedError, HOSTED_ORIGIN, HostedError, isBlocked, type Workspace } from '@/lib/hosted';
import { clearHostedAccount, loadHostedAccount } from '@/lib/hosted-credentials';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';

type Step = 'loading' | 'email' | 'code' | 'working' | 'waiting' | 'resume';

// A resend is allowed after this long; the service limits sends too.
const RESEND_MS = 60_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign in to the hosted workspace with an email code: email, code, then the workspace wakes if it sleeps. */
export default function HostedSignIn() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const { hostedSignIn, hostedContinue } = useAuth();
  const api = useMemo(() => createHostedApi(), []);
  const [step, setStep] = useState<Step>('loading');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [savedEmail, setSavedEmail] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [eligible, setEligible] = useState(true);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // A sign-in that stopped halfway (the app was closed while the workspace started) can be carried on.
    void loadHostedAccount().then((account) => {
      if (!alive.current) return;
      if (account) {
        setSavedEmail(account.email);
        setStep('resume');
      } else {
        setStep('email');
      }
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = (caught: unknown) => {
    if (!alive.current) return;
    if (caught instanceof HostedError) {
      setError(describeHostedError(caught));
      setEligible(caught.code !== 'no_eligible_workspace');
    } else {
      setError('Something went wrong. Try again.');
    }
  };

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedCode = code.replace(/\s/g, '');
  const emailOk = EMAIL.test(normalizedEmail);
  const codeOk = /^\d{6}$/.test(normalizedCode);

  const sendCode = async () => {
    if (!emailOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.startEmail(normalizedEmail);
      if (!alive.current) return;
      setSentAt(Date.now());
      setCode('');
      setStep('code');
    } catch (caught) {
      fail(caught);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** Runs a sign-in step with progress shown; a failure goes back to `back` (or to the email when the sign-in itself ended). */
  const finish = async (run: () => Promise<{ kind: 'connected' } | { kind: 'waiting'; workspace: Workspace }>, back: Step) => {
    setBusy(true);
    setError(null);
    setStep('working');
    try {
      const result = await run();
      if (!alive.current) return;
      // `connected` flips the app to the signed-in screens by itself; nothing more to draw here.
      if (result.kind === 'waiting') {
        setWorkspace(result.workspace);
        setStep('waiting');
      }
    } catch (caught) {
      fail(caught);
      if (alive.current) setStep(caught instanceof HostedError && caught.code === 'session_invalid' ? 'email' : back);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const signIn = () => {
    if (!codeOk || busy) return;
    void finish(() => hostedSignIn({ email: normalizedEmail, code: normalizedCode, onUpdate: (update) => alive.current && setWorkspace(update) }), 'code');
  };

  const carryOn = () => void finish(() => hostedContinue({ onUpdate: (update) => alive.current && setWorkspace(update) }), step === 'resume' ? 'resume' : 'waiting');

  const another = async () => {
    await clearHostedAccount();
    setSavedEmail('');
    setWorkspace(null);
    setError(null);
    setStep('email');
  };

  const shown = workspace ? describeAvailability(workspace.availability) : { title: 'Starting your workspace', detail: 'This can take a minute or two. You can leave this screen open.' };

  return (
    <KeyboardScreen>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.heading}>
          Your hosted workspace
        </Text>
        <Text style={styles.lead}>Sign in with the email of your Suparagent account. Your agents run in the cloud, so you can use them from here without your computer on.</Text>

        {step === 'loading' ? <ActivityIndicator color={theme.accent} accessibilityLabel="Loading" /> : null}

        {step === 'email' ? (
          <>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={theme.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
            />
            {email.trim() && !emailOk ? <Text style={styles.problem}>Enter the email address of your account.</Text> : null}
            <Pressable accessibilityRole="button" style={[styles.primary, (!emailOk || busy) && styles.disabled]} disabled={!emailOk || busy} onPress={() => void sendCode()}>
              {busy ? <ActivityIndicator color={theme.onAccent} /> : <Text style={styles.primaryText}>Send me a code</Text>}
            </Pressable>
            <Text style={styles.help}>Hosted workspaces need a paid plan. Your computer’s own agents and conversations are not copied; the hosted workspace has its own.</Text>
          </>
        ) : null}

        {step === 'code' ? (
          <>
            <Text style={styles.notice}>If {normalizedEmail} has an account, we sent it a 6-digit code. It works for 10 minutes.</Text>
            <Text style={styles.label}>Code</Text>
            <TextInput
              style={[styles.input, styles.code]}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              placeholderTextColor={theme.muted}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={7}
            />
            {code.trim() && !codeOk ? <Text style={styles.problem}>The code has 6 digits.</Text> : null}
            <Pressable accessibilityRole="button" style={[styles.primary, (!codeOk || busy) && styles.disabled]} disabled={!codeOk || busy} onPress={signIn}>
              <Text style={styles.primaryText}>Sign in</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[styles.secondary, busy && styles.disabled]} disabled={busy} onPress={() => (Date.now() - sentAt >= RESEND_MS ? void sendCode() : setError('Wait a minute before asking for another code.'))}>
              <Text style={styles.secondaryText}>Send a new code</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => { setError(null); setStep('email'); }}>
              <Text style={styles.secondaryText}>Use a different email</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'working' ? (
          <View style={styles.progress} accessibilityLiveRegion="polite">
            <ActivityIndicator color={theme.accent} accessibilityLabel="Working" />
            <Text style={styles.progressTitle}>{shown.title}</Text>
            {shown.detail ? <Text style={styles.lead}>{shown.detail}</Text> : null}
          </View>
        ) : null}

        {step === 'waiting' ? (
          <View style={styles.progress} accessibilityLiveRegion="polite">
            <Text style={styles.progressTitle}>{shown.title}</Text>
            <Text style={styles.lead}>{shown.detail}</Text>
            <Pressable accessibilityRole="button" style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={carryOn}>
              <Text style={styles.primaryText}>{workspace && isBlocked(workspace.availability) ? 'Check again' : 'Continue'}</Text>
            </Pressable>
            {workspace && isBlocked(workspace.availability) ? (
              <Pressable accessibilityRole="link" style={styles.secondary} onPress={() => void Linking.openURL(`${HOSTED_ORIGIN}/account/billing`)}>
                <Text style={styles.secondaryText}>Open plan and billing</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void another()}>
              <Text style={styles.secondaryText}>Sign out</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'resume' ? (
          <View style={styles.progress}>
            <Text style={styles.progressTitle}>Signed in as {savedEmail}</Text>
            <Text style={styles.lead}>Finish connecting this phone to your workspace.</Text>
            <Pressable accessibilityRole="button" style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={carryOn}>
              <Text style={styles.primaryText}>Continue</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void another()}>
              <Text style={styles.secondaryText}>Use a different account</Text>
            </Pressable>
          </View>
        ) : null}

        {error ? (
          <Text style={styles.problem} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {error && !eligible ? (
          <Pressable accessibilityRole="link" style={styles.secondary} onPress={() => void Linking.openURL(`${HOSTED_ORIGIN}/pricing`)}>
            <Text style={styles.secondaryText}>See hosted plans</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    container: { padding: 20, gap: 8 },
    heading: { fontSize: 24, fontWeight: '700', color: p.text },
    lead: { fontSize: 15, color: p.muted },
    label: { fontSize: 14, fontWeight: '600', marginTop: 12, color: p.text },
    input: { minHeight: touch.min, borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: p.text },
    code: { letterSpacing: 4 },
    notice: { fontSize: 15, color: p.text, marginTop: 8 },
    problem: { fontSize: 14, color: p.danger },
    help: { marginTop: 16, fontSize: 13, color: p.muted },
    primary: { marginTop: 16, minHeight: touch.min + 4, justifyContent: 'center', backgroundColor: p.accent, borderRadius: radius.field, alignItems: 'center' },
    primaryText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    secondary: { minHeight: touch.min, justifyContent: 'center', alignItems: 'center' },
    secondaryText: { color: p.accentText, fontSize: 15, fontWeight: '500' },
    progress: { gap: 10, marginTop: 16, alignItems: 'stretch' },
    progressTitle: { fontSize: 18, fontWeight: '600', color: p.text },
    disabled: { opacity: 0.5 },
  });
