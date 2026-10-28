import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { describeApiError } from '@/lib/api';
import { roomBusy, workingNames, type Room } from '@/lib/rooms';
import { useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

export default function Rooms() {
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setRooms(await api.listRooms());
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [api]);

  // Read again whenever the list comes back into view, so unread marks reflect what was just read.
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

  return (
    <View style={styles.flex}>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {rooms === null && !error ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={rooms ?? []}
          keyExtractor={(room) => String(room.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListEmptyComponent={rooms ? <Text style={styles.empty}>No rooms yet. Rooms are made in the web app.</Text> : undefined}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" style={styles.row} onPress={() => router.push({ pathname: '/rooms/[id]', params: { id: String(item.id) } })}>
              <View style={styles.line}>
                <Text style={[styles.name, item.unread && styles.unreadName]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.unread ? <View accessibilityLabel="Unread messages" style={styles.dot} /> : null}
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {roomBusy(item) ? `${workingNames(item).join(', ') || 'An agent'} working · ` : ''}
                {item.members.map((member) => member.name).join(', ')}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    error: { color: p.danger, padding: 12, fontSize: 14 },
    empty: { textAlign: 'center', marginTop: 40, fontSize: 16, color: p.muted, paddingHorizontal: 24 },
    row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { fontSize: 16, color: p.text, flexShrink: 1 },
    unreadName: { fontWeight: '700' },
    dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: p.accent },
    meta: { fontSize: 13, color: p.muted, marginTop: 2 },
  });
