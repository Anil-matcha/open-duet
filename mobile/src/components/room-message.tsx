import { StyleSheet, Text, View } from 'react-native';

import { Markdown } from '@/components/markdown';
import type { RoomItem } from '@/lib/rooms';
import { radius, useStyles, type Palette } from '@/lib/theme';

// Yours on the right; each agent's on the left under its name; roster changes and the like as a muted line.
export function RoomMessage({ item }: { item: RoomItem }) {
  const styles = useStyles(createStyles);
  if (item.kind === 'notice') return <Text style={styles.notice}>{item.text}</Text>;
  if (item.mine) {
    return (
      <View style={[styles.bubble, styles.mine]}>
        <Text selectable style={styles.mineText}>
          {item.text}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.bubble, styles.theirs]}>
      <Text style={styles.author}>{item.author}</Text>
      <Markdown text={item.text} />
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    bubble: { maxWidth: '88%', borderRadius: radius.card, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
    mine: { alignSelf: 'flex-end', backgroundColor: p.accent },
    theirs: { alignSelf: 'flex-start', backgroundColor: p.surface },
    mineText: { color: p.onAccent, fontSize: 16 },
    author: { color: p.muted, fontSize: 12, fontWeight: '700', marginBottom: 2 },
    notice: { color: p.muted, fontSize: 13, textAlign: 'center', marginVertical: 6, paddingHorizontal: 4 },
  });
