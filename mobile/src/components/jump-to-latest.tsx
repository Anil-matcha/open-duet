// From the icon set's own path: the package root would bundle every icon font.
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet } from 'react-native';

import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';

/** A round button over the corner of a conversation, shown while the reader has scrolled up from the newest message. */
export function JumpToLatest({ onPress }: { onPress: () => void }) {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={onPress}>
      <Feather name="arrow-down" size={20} color={theme.text} />
    </Pressable>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    button: {
      position: 'absolute',
      right: 16,
      bottom: 12,
      width: touch.min,
      height: touch.min,
      borderRadius: radius.round,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.background,
      borderWidth: 1,
      borderColor: p.border,
      elevation: 3,
      shadowColor: p.text,
      shadowOpacity: 0.15,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
    },
    pressed: { backgroundColor: p.surface },
  });
