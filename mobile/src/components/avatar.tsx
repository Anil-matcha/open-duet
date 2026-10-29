import { Feather } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { identityColor, initialOf, ON_IDENTITY } from '@/lib/identity';
import { radius, useStyles, useTheme, type Palette } from '@/lib/theme';

const SIZES = { sm: { box: 28, text: 13, icon: 14 }, md: { box: 40, text: 17, icon: 20 } } as const;

/**
 * An agent's picture, as on the web: its first letter on a colour taken from its id. With no agent (a plain
 * chat) a neutral chat glyph. Decorative: the name is always written beside it.
 */
export function Avatar({ agentId, name, size = 'md' }: { agentId: number | null; name?: string | null; size?: keyof typeof SIZES }) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const { box, text, icon } = SIZES[size];
  const frame = { width: box, height: box };
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.base, frame, agentId === null ? styles.neutral : { backgroundColor: identityColor(agentId) }]}>
      {agentId === null ? <Feather name="message-square" size={icon} color={theme.muted} /> : <Text style={[styles.letter, { fontSize: text }]}>{initialOf(name)}</Text>}
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    base: { borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
    neutral: { backgroundColor: p.surface },
    letter: { color: ON_IDENTITY, fontWeight: '600' },
  });
