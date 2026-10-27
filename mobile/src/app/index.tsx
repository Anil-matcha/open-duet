import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { describeApiError, type Thread } from '@/lib/api';
import { relativeTime } from '@/lib/time';
import { useApi } from '@/lib/use-api';

export default function Conversations() {
  const api = useApi();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setThreads(await api.listThreads());
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [api]);

  // Reload whenever the list comes back into view, so a conversation started elsewhere shows up.
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

  const create = async () => {
    if (!api || creating) return;
    setCreating(true);
    try {
      const thread = await api.createThread();
      router.push({ pathname: '/thread/[id]', params: { id: String(thread.id) } });
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.flex}>
      <Pressable accessibilityRole="button" accessibilityLabel="New conversation" style={[styles.new, creating && styles.disabled]} disabled={creating} onPress={create}>
        {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.newText}>New conversation</Text>}
      </Pressable>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {threads === null && !error ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={threads ?? []}
          keyExtractor={(thread) => String(thread.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListEmptyComponent={threads ? <Text style={styles.empty}>No conversations yet.</Text> : undefined}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" style={styles.row} onPress={() => router.push({ pathname: '/thread/[id]', params: { id: String(item.id) } })}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title || 'New conversation'}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {[item.provider, item.model, relativeTime(item.updated_at)].filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  new: { margin: 12, backgroundColor: '#0a7ea4', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  newText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  error: { color: '#b91c1c', paddingHorizontal: 12, paddingBottom: 8, fontSize: 14 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 16, color: '#666' },
  row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#bbb' },
  title: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 13, color: '#666', marginTop: 2 },
});
