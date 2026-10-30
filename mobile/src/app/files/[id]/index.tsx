import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { describeFileError } from '@/lib/api';
import { folderTitle, formatBytes, type FileEntry, type Folder } from '@/lib/files';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

/** One folder of a conversation's workspace; a folder opens this screen again, a file opens the viewer. */
export default function Files() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const router = useRouter();
  const api = useApi();
  const { id, path = '' } = useLocalSearchParams<{ id: string; path?: string }>();
  const threadId = Number(id);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    setFolder(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.listFiles(threadId, path).then(
      (listing) => current && setFolder(listing),
      (err) => current && setError(describeFileError(err)),
    );
    return () => {
      current = false;
    };
  }, [api, threadId, path, attempt]);

  const open = (entry: FileEntry) =>
    entry.type === 'dir'
      ? router.push({ pathname: '/files/[id]', params: { id: String(threadId), path: entry.path } })
      : router.push({ pathname: '/files/[id]/view', params: { id: String(threadId), path: entry.path } });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: folderTitle(path) }} />
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
          <Pressable accessibilityRole="button" style={styles.retry} onPress={load}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : !folder ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <FlatList
          data={folder.entries}
          keyExtractor={(entry) => entry.path}
          ListEmptyComponent={<Text style={styles.hint}>This folder is empty.</Text>}
          ListFooterComponent={folder.truncated ? <Text style={styles.hint}>This folder has more items than can be listed here.</Text> : undefined}
          renderItem={({ item }) => {
            const secret = item.type === 'hidden';
            const detail = secret ? 'Secret file, not shown' : item.type === 'dir' ? '' : item.bytes !== null ? formatBytes(item.bytes) : '';
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: secret }}
                accessibilityLabel={[item.type === 'dir' ? 'Folder' : 'File', item.name, detail].filter(Boolean).join(', ')}
                disabled={secret}
                style={({ pressed }) => [styles.row, secret && styles.dim, pressed && styles.pressed]}
                onPress={() => open(item)}
              >
                <Feather name={item.type === 'dir' ? 'folder' : secret ? 'lock' : 'file-text'} size={20} color={item.type === 'dir' ? theme.accentText : theme.muted} />
                <View style={styles.text}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {detail ? <Text style={styles.detail}>{detail}</Text> : null}
                </View>
                {item.type === 'dir' ? <Feather name="chevron-right" size={18} color={theme.muted} /> : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background },
    center: { alignItems: 'center', marginTop: 40, gap: 12, paddingHorizontal: 24 },
    hint: { textAlign: 'center', marginTop: 40, paddingHorizontal: 24, fontSize: 16, color: p.muted },
    error: { color: p.danger, textAlign: 'center', fontSize: 15 },
    retry: { minHeight: touch.min, justifyContent: 'center', borderWidth: 1, borderColor: p.accentText, borderRadius: radius.field, paddingHorizontal: 16 },
    retryText: { color: p.accentText, fontSize: 16, fontWeight: '600' },
    row: { minHeight: touch.min + 8, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    pressed: { backgroundColor: p.surface },
    dim: { opacity: 0.6 },
    text: { flex: 1 },
    name: { fontSize: 16, color: p.text },
    detail: { fontSize: 13, color: p.muted, marginTop: 1 },
  });
