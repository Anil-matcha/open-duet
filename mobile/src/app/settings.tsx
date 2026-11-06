import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';

import { useRouter } from 'expo-router';

import { Text } from '@/components/text';
import { canManageAgents } from '@/lib/agents';
import { useAuth } from '@/lib/auth-context';
import { HOSTED_ORIGIN } from '@/lib/hosted';
import { isPlainHttp, NOT_ENCRYPTED_NOTICE, serverLabel } from '@/lib/server-url';
import { radius, useStyles, type Palette } from '@/lib/theme';

export default function Settings() {
  const styles = useStyles(createStyles);
  const router = useRouter();
  const { state, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  if (state.status !== 'paired') return null;

  const hosted = state.hosted;
  const confirmSignOut = () => {
    Alert.alert(
      hosted ? 'Sign out of your hosted workspace?' : 'Sign out and forget this server?',
      hosted ? 'This phone will be signed out of your workspace. Your agents and conversations stay in the cloud; sign in again to use them.' : 'This phone will be signed out on your server and forget its address. You can pair again with a new code.',
      [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          await signOut();
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      {hosted ? (
        <>
          <Text style={styles.label}>Workspace</Text>
          <Text style={styles.value}>Hosted ({serverLabel(state.server)})</Text>
          <Text style={styles.label}>Account</Text>
          <Text style={styles.value}>{hosted.email}</Text>
        </>
      ) : (
        <>
          <Text style={styles.label}>Server address</Text>
          <Text style={styles.value}>{serverLabel(state.server)}</Text>
          {isPlainHttp(state.server) ? <Text style={styles.notice}>{NOT_ENCRYPTED_NOTICE}</Text> : null}
        </>
      )}
      <Text style={styles.label}>Device name</Text>
      <Text style={styles.value}>{state.label || 'Phone'}</Text>
      <Text style={styles.label}>Access</Text>
      <Text style={styles.value}>{accessText(state.scopes)}</Text>
      {canManageAgents(state.scopes) ? (
        <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => router.push('/agents')}>
          <Text style={styles.rowText}>Agents</Text>
          <Text style={styles.value}>Create and edit</Text>
        </Pressable>
      ) : null}
      {hosted ? (
        <Pressable accessibilityRole="link" style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => void Linking.openURL(`${HOSTED_ORIGIN}/account/phones`)}>
          <Text style={styles.rowText}>Connected phones</Text>
          <Text style={styles.value}>Manage on suparagent.ai</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" style={[styles.danger, busy && styles.disabled]} disabled={busy} onPress={confirmSignOut}>
        <Text style={styles.dangerText}>{hosted ? 'Sign out of the hosted workspace' : 'Sign out and forget this server'}</Text>
      </Pressable>
    </View>
  );
}

function accessText(scopes: readonly string[]): string {
  const files = scopes.includes('files');
  if (canManageAgents(scopes)) return 'Chat, files and agents';
  return files ? 'Chat and files' : 'Chat only';
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    container: { padding: 20, gap: 4 },
    label: { fontSize: 13, fontWeight: '600', marginTop: 12, color: p.muted },
    value: { fontSize: 16, color: p.text },
    notice: { fontSize: 14, color: p.notice },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginTop: 16, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border },
    rowText: { fontSize: 16, fontWeight: '600', color: p.text },
    pressed: { opacity: 0.7 },
    danger: { marginTop: 32, borderWidth: 1, borderColor: p.danger, borderRadius: radius.field, paddingVertical: 14, alignItems: 'center' },
    dangerText: { color: p.danger, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.5 },
  });
