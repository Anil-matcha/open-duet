import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import { agentSummary, type Agent } from '@/lib/agents';
import { MEMBERS_MAX } from '@/lib/room-draft';
import { radius, touch, useStyles, type Palette } from '@/lib/theme';

/** The agents to choose a room's members from, as rows with a check. At most 12 can be chosen. */
export function MemberPicker({ agents, selected, onToggle }: { agents: Agent[]; selected: number[]; onToggle: (agentId: number) => void }) {
  const styles = useStyles(createStyles);
  const full = selected.length >= MEMBERS_MAX;
  if (agents.length === 0) return <Text style={styles.empty}>You have no agents yet. Make one in Settings → Agents first.</Text>;
  return (
    <View style={styles.list}>
      {agents.map((agent) => {
        const on = selected.includes(agent.id);
        const blocked = full && !on;
        return (
          <Pressable
            key={agent.id}
            accessibilityRole="checkbox"
            accessibilityLabel={agent.name}
            accessibilityState={{ checked: on, disabled: blocked }}
            disabled={blocked}
            style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed, blocked && styles.disabled]}
            onPress={() => onToggle(agent.id)}
          >
            <Avatar agentId={agent.id} name={agent.name} size="sm" />
            <View style={styles.text}>
              <Text style={styles.name} numberOfLines={1}>
                {agent.name}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {agentSummary(agent)}
              </Text>
            </View>
            <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    list: { gap: 8 },
    empty: { fontSize: 14, color: p.muted },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: touch.min + 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: p.border, borderRadius: radius.field },
    rowOn: { borderColor: p.accent, backgroundColor: p.surface },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
    text: { flex: 1 },
    name: { fontSize: 16, color: p.text },
    meta: { fontSize: 13, color: p.muted },
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: p.inputBorder, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: p.accent, borderColor: p.accent },
    tick: { color: p.onAccent, fontSize: 14, fontWeight: '700' },
  });
