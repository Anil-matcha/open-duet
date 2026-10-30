import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { KeyboardScreen } from '@/components/keyboard-screen';
import { Text, TextInput } from '@/components/text';
import { MONO } from '@/lib/fonts';
import { ALLOW_HTTP, useAuth } from '@/lib/auth-context';
import { describePairingError, describeServerCheck, PairingError } from '@/lib/pairing-api';
import { formatPairingCode, normalizePairingCode } from '@/lib/pairing-link';
import { describeServerUrlProblem, normalizeServerUrl, serverLabel } from '@/lib/server-url';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';
import { useServerCheck } from '@/lib/use-server-check';

const STEPS = [
  'On your server, open Settings → Devices.',
  'Set Access to “Chat only” (or “Chat and files” to open the files agents make) and create a pairing code.',
  'Scan its QR code here, or type the address and code below.',
];

export default function Pair() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const { pair, notice } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ server?: string; code?: string }>();
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [fromLink, setFromLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A scanned or opened link fills the fields once per link; the person still taps Connect.
  const linkKey = `${params.server ?? ''}|${params.code ?? ''}`;
  const [appliedLink, setAppliedLink] = useState('|');
  if (linkKey !== appliedLink) {
    setAppliedLink(linkKey);
    if (params.server) setServer(params.server);
    if (params.code) {
      setCode(formatPairingCode(params.code));
      setFromLink(true);
    }
  }

  const target = normalizeServerUrl(server, { allowHttp: ALLOW_HTTP });
  const normalizedCode = normalizePairingCode(code);
  const canConnect = target.ok && normalizedCode !== null && !busy;
  // Asks the address, before any code is sent to it, whether it is a server this app can pair with.
  const check = useServerCheck(target.ok ? target.url : null);
  const verdict = check === 'idle' || check === 'checking' ? null : describeServerCheck(check);

  const connect = async () => {
    if (!target.ok || !normalizedCode) return;
    setBusy(true);
    setError(null);
    try {
      await pair({ server: target.url, code: normalizedCode });
    } catch (err) {
      setError(err instanceof PairingError ? describePairingError(err) : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <KeyboardScreen>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.heading}>
          Connect to your server
        </Text>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <View style={styles.steps}>
          {STEPS.map((step, index) => (
            <View key={step} style={styles.step}>
              <View style={styles.number}>
                <Text style={styles.numberText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        <Pressable accessibilityRole="button" style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={() => router.push('/scan')}>
          <Text style={styles.primaryText}>Scan QR code</Text>
        </Pressable>

        <Text style={styles.or}>or type them in</Text>

        <Text style={styles.label}>Server address</Text>
        <TextInput
          style={styles.input}
          value={server}
          onChangeText={setServer}
          placeholder="https://dots.example.com"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        {server.trim() && !target.ok ? <Text style={styles.problem}>{describeServerUrlProblem(target.reason)}</Text> : null}
        {target.ok ? (
          <Text style={styles.target}>
            You are connecting to <Text style={styles.bold}>{serverLabel(target.url)}</Text>
            {fromLink ? '. Make sure this is your own server before you connect.' : ''}
          </Text>
        ) : null}
        {target.ok && check === 'checking' ? (
          <Text style={styles.checking} accessibilityLiveRegion="polite">
            Checking the address…
          </Text>
        ) : null}
        {target.ok && verdict ? (
          <Text style={verdict.tone === 'good' ? styles.good : verdict.tone === 'warn' ? styles.warn : styles.problem} accessibilityLiveRegion="polite">
            {verdict.tone === 'good' ? '✓ ' : ''}
            {verdict.text}
          </Text>
        ) : null}

        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          style={[styles.input, styles.code]}
          value={code}
          onChangeText={setCode}
          placeholder="ABCD-EFGH"
          placeholderTextColor={theme.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
        />
        {code.trim() && !normalizedCode ? <Text style={styles.problem}>A pairing code has 8 letters and numbers.</Text> : null}

        {error ? (
          <Text style={styles.problem} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Pressable accessibilityRole="button" style={[styles.connect, !canConnect && styles.disabled]} disabled={!canConnect} onPress={connect}>
          {busy ? <ActivityIndicator color={theme.onAccent} /> : <Text style={styles.primaryText}>Connect</Text>}
        </Pressable>

        <Text style={styles.help}>
          Trouble connecting? Your server has to be reachable from this phone: on the same Wi-Fi, over a VPN such as Tailscale, or at a public HTTPS address. The address must start with https://.
        </Text>
      </ScrollView>
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    container: { padding: 20, gap: 8 },
    heading: { fontSize: 24, fontWeight: '700', color: p.text },
    notice: { fontSize: 15, color: p.notice, marginTop: 4 },
    steps: { gap: 10, marginTop: 8, marginBottom: 12 },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    number: { width: 26, height: 26, borderRadius: radius.round, backgroundColor: p.surface, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    numberText: { fontSize: 14, fontWeight: '600', color: p.text },
    stepText: { flex: 1, fontSize: 15, color: p.text },
    or: { textAlign: 'center', color: p.muted, fontSize: 14, marginVertical: 8 },
    label: { fontSize: 14, fontWeight: '600', marginTop: 8, color: p.text },
    input: { minHeight: touch.min, borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: p.text },
    code: { fontFamily: MONO, letterSpacing: 2 },
    target: { fontSize: 14, color: p.text },
    bold: { fontWeight: '700' },
    checking: { fontSize: 14, color: p.muted },
    good: { fontSize: 14, color: p.success },
    warn: { fontSize: 14, color: p.notice },
    problem: { fontSize: 14, color: p.danger },
    primary: { minHeight: touch.min + 4, justifyContent: 'center', backgroundColor: p.accent, borderRadius: radius.field, alignItems: 'center' },
    connect: { marginTop: 16, minHeight: touch.min + 4, justifyContent: 'center', backgroundColor: p.accent, borderRadius: radius.field, alignItems: 'center' },
    primaryText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
    help: { marginTop: 20, fontSize: 13, color: p.muted },
  });
