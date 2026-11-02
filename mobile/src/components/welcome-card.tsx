import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { useAuth } from '@/lib/auth-context';
import { serverLabel } from '@/lib/server-url';
import { radius, touch, useStyles, type Palette } from '@/lib/theme';

/** Shown once after pairing: which server this is, and what a phone paired for chat can and cannot do. */
export function WelcomeCard() {
  const styles = useStyles(createStyles);
  const { state, welcome, dismissWelcome } = useAuth();
  if (!welcome || state.status !== 'paired') return null;
  return (
    <View style={styles.card} accessibilityLabel="Connected">
      <Text style={styles.title}>Connected to {serverLabel(state.server)}</Text>
      <Text style={styles.body}>
        From this phone you can chat with your agents, stop an answer, and allow or deny a tool call. Agents, settings and who can sign in are managed on your server, not here.
      </Text>
      <Pressable accessibilityRole="button" hitSlop={8} style={styles.button} onPress={dismissWelcome}>
        <Text style={styles.buttonText}>Got it</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    card: { marginHorizontal: 12, marginBottom: 8, padding: 14, borderRadius: radius.card, backgroundColor: p.surface, gap: 6 },
    title: { fontSize: 16, fontWeight: '600', color: p.text },
    body: { fontSize: 14, color: p.text },
    button: { alignSelf: 'flex-start', minHeight: touch.min, justifyContent: 'center', paddingRight: 12 },
    buttonText: { fontSize: 15, fontWeight: '600', color: p.accentText },
  });
