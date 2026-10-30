import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { describeFileError } from '@/lib/api';
import { shareFile } from '@/lib/file-actions';
import { baseName, formatBytes, type Preview } from '@/lib/files';
import { MONO } from '@/lib/fonts';
import { radius, touch, useStyles, useTheme, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

/** A workspace file: its text or image where the phone can show it, and Share for any file. */
export default function FileView() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const api = useApi();
  const { id, path = '' } = useLocalSearchParams<{ id: string; path?: string }>();
  const threadId = Number(id);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.previewFile(threadId, path).then(
      (found) => current && setPreview(found),
      (err) => current && setError(describeFileError(err)),
    );
    return () => {
      current = false;
    };
  }, [api, threadId, path, attempt]);

  const image = useMemo(() => (api && preview?.kind === 'image' ? api.fileSource(threadId, path, 'raw') : null), [api, preview, threadId, path]);

  const share = async () => {
    if (!api || !preview) return;
    setSharing(true);
    setNote(null);
    try {
      const result = await shareFile(api.fileSource(threadId, path, 'download'), preview.name, preview.mime);
      if (result === 'unavailable') setNote('Sharing is not available on this phone.');
    } catch {
      setNote('Could not download the file. Check your connection and try again.');
    } finally {
      setSharing(false);
    }
  };

  const name = preview?.name || baseName(path) || 'File';
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: name }} />
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.retry}
            onPress={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : !preview ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <Text style={styles.meta}>
            {preview.mime} · {formatBytes(preview.bytes)}
          </Text>
          {preview.kind === 'text' ? (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <Text selectable style={styles.code}>
                  {preview.text ?? ''}
                </Text>
              </ScrollView>
              {preview.truncated ? <Text style={styles.hint}>Showing the start of the file. Share it to get all of it.</Text> : null}
            </ScrollView>
          ) : preview.kind === 'image' && image && !imageFailed ? (
            <Image accessibilityLabel={name} source={image} style={styles.image} resizeMode="contain" onError={() => setImageFailed(true)} />
          ) : (
            <Text style={styles.hint}>
              {preview.kind === 'image' ? 'This image could not be shown.' : 'This kind of file cannot be previewed here.'} Share it to open it in another app.
            </Text>
          )}
          {note ? (
            <Text style={styles.error} accessibilityRole="alert">
              {note}
            </Text>
          ) : null}
          <Pressable accessibilityRole="button" style={[styles.share, sharing && styles.disabled]} disabled={sharing} onPress={share}>
            {sharing ? <ActivityIndicator color={theme.onAccent} /> : <Text style={styles.shareText}>Share or save</Text>}
          </Pressable>
        </>
      )}
    </View>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background, padding: 16, gap: 12 },
    center: { alignItems: 'center', marginTop: 40, gap: 12 },
    meta: { fontSize: 13, color: p.muted },
    body: { flex: 1, minHeight: 0, backgroundColor: p.surfaceStrong, borderRadius: radius.field },
    bodyContent: { padding: 12 },
    code: { fontFamily: MONO, fontSize: 13, color: p.text },
    image: { flex: 1, minHeight: 0 },
    hint: { textAlign: 'center', fontSize: 15, color: p.muted, marginTop: 12 },
    error: { color: p.danger, textAlign: 'center', fontSize: 15 },
    retry: { minHeight: touch.min, justifyContent: 'center', borderWidth: 1, borderColor: p.accentText, borderRadius: radius.field, paddingHorizontal: 16 },
    retryText: { color: p.accentText, fontSize: 16, fontWeight: '600' },
    share: { minHeight: touch.min + 4, justifyContent: 'center', alignItems: 'center', backgroundColor: p.accent, borderRadius: radius.field },
    shareText: { color: p.onAccent, fontSize: 16, fontWeight: '600' },
    disabled: { opacity: 0.6 },
  });
