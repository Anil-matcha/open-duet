import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { serverLabel } from '@/lib/server-url';
import { radius, useStyles, type Palette } from '@/lib/theme';

export default function Settings() {
  const styles = useStyles(createStyles);
  const { state, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  if (state.status !== 'paired') return null;

  const confirmSignOut = () => {
    Alert.alert('Sign out and forget this server?', 'This phone will be signed out on your server and forget its address. You can pair again with a new code.', [
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
      <Text style={styles.label}>Server address</Text>
      <Text style={styles.value}>{serverLabel(state.server)}</Text>
      <Text style={styles.label}>Device name</Text>
      <Text style={styles.value}>{state.label || 'Phone'}</Text>
      <Text style={styles.label}>Access</Text>
      <Text style={styles.value}>Chat only</Text>
      <Pressable accessibilityRole="button" style={[styles.danger, busy && styles.disabled]} disabled={busy} onPress={confirmSignOut}>
        <Text style={styles.dangerText}>Sign out and forget this server</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    container: { padding: 20, gap: 4 },
    label: { fontSize: 13, fontWeight: '600', marginTop: 12, color: p.muted },
    value: { fontSize: 16, color: p.text },
    danger: { marginTop: 32, borderWidth: 1, borderColor: p.danger, borderRadius: radius.field, paddingVertical: 14, alignItems: 'center' },
    dangerText: { color: p.danger, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.5 },
  });
