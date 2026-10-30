import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
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
    // The same as a conversation: yours a neutral bubble, an agent's message plain text under its name.
    bubble: { marginVertical: 4 },
    mine: { alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: p.bubbleUser, borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 10 },
    theirs: { alignSelf: 'stretch', paddingHorizontal: 4, paddingVertical: 4 },
    mineText: { color: p.text, fontSize: 16 },
    author: { color: p.muted, fontSize: 12, fontWeight: '700', marginBottom: 2 },
    notice: { color: p.muted, fontSize: 13, textAlign: 'center', marginVertical: 6, paddingHorizontal: 4 },
  });
