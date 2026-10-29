import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { KeyboardScreen } from '@/components/keyboard-screen';
import { ALLOW_HTTP, useAuth } from '@/lib/auth-context';
import { describePairingError, PairingError } from '@/lib/pairing-api';
import { formatPairingCode, normalizePairingCode } from '@/lib/pairing-link';
import { describeServerUrlProblem, normalizeServerUrl, serverLabel } from '@/lib/server-url';
import { radius, useStyles, useTheme, type Palette } from '@/lib/theme';

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
        <Text style={styles.body}>
          On your server, open Settings → Devices, set Access to “Chat only”, and create a pairing code. Then scan its app QR code or type the address and code below.
        </Text>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => router.push('/scan')}>
          <Text style={styles.secondaryText}>Scan QR code</Text>
        </Pressable>

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

        <Pressable accessibilityRole="button" style={[styles.primary, !canConnect && styles.disabled]} disabled={!canConnect} onPress={connect}>
          {busy ? <ActivityIndicator color={theme.onAccent} /> : <Text style={styles.primaryText}>Connect</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    container: { padding: 20, gap: 8 },
    body: { fontSize: 15, marginBottom: 8, color: p.text },
    notice: { fontSize: 15, color: p.notice, marginBottom: 8 },
    label: { fontSize: 14, fontWeight: '600', marginTop: 12, color: p.text },
    input: { borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: p.text },
    code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', letterSpacing: 2 },
    target: { fontSize: 14, color: p.text },
    bold: { fontWeight: '700' },
    problem: { fontSize: 14, color: p.danger },
    primary: { marginTop: 16, backgroundColor: p.accent, borderRadius: radius.field, paddingVertical: 14, alignItems: 'center' },
    primaryText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    secondary: { borderWidth: 1, borderColor: p.accentText, borderRadius: radius.field, paddingVertical: 12, alignItems: 'center' },
    secondaryText: { color: p.accentText, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.5 },
  });
