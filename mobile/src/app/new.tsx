import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Text } from '@/components/text';
import { agentSummary, approvalModeLabel, type Agent } from '@/lib/agents';
import { describeApiError } from '@/lib/api';
import { useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

// Choose what to start a conversation with: the server's default, or one of your agents.
export default function NewConversation() {
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<number | 'default' | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(describeApiError(err));
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const start = async (agent: Agent | null) => {
    if (!api || starting !== null) return;
    setStarting(agent ? agent.id : 'default');
    setError(null);
    try {
      const thread = await api.createThread(agent?.id);
      router.replace({ pathname: '/thread/[id]', params: { id: String(thread.id) } });
    } catch (err) {
      setError(describeApiError(err));
      setStarting(null);
    }
  };

  if (agents === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <FlatList
        data={agents}
        keyExtractor={(agent) => String(agent.id)}
        ListHeaderComponent={
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed, starting !== null && styles.disabled]} disabled={starting !== null} onPress={() => start(null)}>
            <Avatar agentId={null} />
            <View style={styles.rowText}>
              <Text style={styles.name}>Default assistant</Text>
              <Text style={styles.meta}>Your server’s usual engine and settings</Text>
            </View>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed, starting !== null && styles.disabled]} disabled={starting !== null} onPress={() => start(item)}>
            <Avatar agentId={item.id} name={item.name} />
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta} numberOfLines={2}>
                {agentSummary(item)}
              </Text>
              <Text style={styles.mode}>{approvalModeLabel(item.approval_mode)}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    error: { color: p.danger, padding: 12, fontSize: 14 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    rowText: { flex: 1 },
    pressed: { backgroundColor: p.surface },
    name: { fontSize: 16, fontWeight: '600', color: p.text },
    meta: { fontSize: 13, color: p.muted, marginTop: 2 },
    mode: { fontSize: 12, color: p.muted, marginTop: 4 },
    disabled: { opacity: 0.5 },
  });
