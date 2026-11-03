import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ActionSheet, Button, SwitchRow, type SheetAction } from '@/components/form';
import { Text } from '@/components/text';
import { agentSummary, approvalModeLabel, canManageAgents, type Agent } from '@/lib/agents';
import { describeSaveError } from '@/lib/agent-draft';
import { useAuth } from '@/lib/auth-context';
import { describeApiError } from '@/lib/api';
import { radius, touch, useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

// Your agents, for a phone paired with "Chat, files and agents": open one to edit it, make a new one, or use the
// "⋯" menu to copy, pin or archive. Deleting an agent, its notes, skills, folder and connected apps stay in the web app.
export default function Agents() {
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const { state } = useAuth();
  const allowed = state.status === 'paired' && canManageAgents(state.scopes);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<Agent | null>(null);

  const load = useCallback(async () => {
    if (!api || !allowed) return;
    try {
      setAgents(await api.listAgents(showArchived));
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
      setAgents((current) => current ?? []);
    }
  }, [api, allowed, showArchived]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(describeSaveError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const menuActions = (agent: Agent): SheetAction[] => {
    if (!api) return [];
    const archived = !!agent.archived_at;
    return [
      { label: 'Edit', onPress: () => router.push({ pathname: '/agents/[id]', params: { id: String(agent.id) } }) },
      // The copy is never looser than the original: its own folder, and "Ask first" for "Accept edits".
      { label: 'Duplicate', onPress: () => act(() => api.duplicateAgent(agent.id)) },
      { label: agent.pinned ? 'Unpin' : 'Pin to top', onPress: () => act(() => api.updateAgent(agent.id, { pinned: !agent.pinned })) },
      { label: archived ? 'Restore' : 'Archive', onPress: () => act(() => api.updateAgent(agent.id, { archived: !archived })) },
    ];
  };

  if (!allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>This phone was not paired to manage agents. On your server open Settings → Devices, create a code with Access set to “Chat, files and agents”, and pair again.</Text>
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
      {agents === null ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(agent) => String(agent.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListHeaderComponent={
            <View style={styles.header}>
              <Button label="New agent" onPress={() => router.push({ pathname: '/agents/[id]', params: { id: 'new' } })} />
              <SwitchRow label="Show archived" value={showArchived} onValueChange={setShowArchived} />
            </View>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>No agents yet. An agent keeps its own instructions, model, workspace, approval mode and notes.</Text>
          }
          renderItem={({ item }) => (
            <View style={[styles.row, !!item.archived_at && styles.archived]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edit ${item.name}`}
                style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
                onPress={() => router.push({ pathname: '/agents/[id]', params: { id: String(item.id) } })}
              >
                <Avatar agentId={item.id} name={item.name} />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.meta} numberOfLines={2}>
                    {agentSummary(item)}
                  </Text>
                  <Text style={styles.mode}>
                    {[approvalModeLabel(item.approval_mode), item.pinned ? 'Pinned' : null, item.archived_at ? 'Archived' : null].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`More actions for ${item.name}`} style={styles.more} onPress={() => setMenu(item)} disabled={busy}>
                <Text style={styles.moreText}>⋯</Text>
              </Pressable>
            </View>
          )}
        />
      )}
      <ActionSheet title={menu?.name ?? ''} actions={menu ? menuActions(menu) : null} onClose={() => setMenu(null)} />
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    header: { padding: 16, paddingBottom: 4 },
    error: { color: p.danger, padding: 12, fontSize: 14 },
    empty: { color: p.muted, fontSize: 15, padding: 20, textAlign: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    archived: { opacity: 0.6 },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingVertical: 12 },
    rowText: { flex: 1 },
    pressed: { backgroundColor: p.surface },
    name: { fontSize: 16, fontWeight: '600', color: p.text },
    meta: { fontSize: 13, color: p.muted, marginTop: 2 },
    mode: { fontSize: 12, color: p.muted, marginTop: 4 },
    more: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center', borderRadius: radius.round },
    moreText: { fontSize: 22, color: p.muted },
  });
