import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import { useStyles, type Palette } from '@/lib/theme';

/** The header of a conversation, as on the web: the agent's picture, the title, and the agent's name beneath. */
export function ConversationTitle({ title, agentId, agentName }: { title: string; agentId: number | null; agentName: string | null }) {
  const styles = useStyles(createStyles);
  return (
    <View style={styles.row} accessible accessibilityRole="header" accessibilityLabel={agentName ? `${title}, ${agentName}` : title}>
      <Avatar agentId={agentId} name={agentName} size="sm" />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {agentName ? (
          <Text style={styles.agent} numberOfLines={1}>
            {agentName}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 240 },
    text: { flexShrink: 1 },
    title: { fontSize: 17, fontWeight: '600', color: p.text },
    agent: { fontSize: 12, color: p.muted },
  });
