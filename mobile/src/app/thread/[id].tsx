import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { Composer } from '@/components/composer';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { TranscriptRow, type Row } from '@/components/transcript-row';
import { useThread } from '@/lib/use-thread';

const BANNER: Record<string, string> = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' };

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transcript, thread, connection, error, loaded, running, send, stop } = useThread(Number(id));
  const list = useRef<FlatList<Row>>(null);
  const stuckToEnd = useRef(true);

  const rows: Row[] = transcript.typing ? [...transcript.items, { kind: 'typing', key: 'typing', text: transcript.typing }] : transcript.items;

  return (
    <KeyboardScreen>
      <Stack.Screen options={{ title: thread?.title || 'Conversation' }} />
      {BANNER[connection] ? <Text style={styles.banner}>{BANNER[connection]}</Text> : null}
      {!loaded ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Say something to start.</Text>
        </View>
      ) : (
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => <TranscriptRow row={item} />}
          contentContainerStyle={styles.content}
          // Follow new text unless the person scrolled up to read.
          onScroll={({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            stuckToEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (stuckToEnd.current) list.current?.scrollToEnd({ animated: true });
          }}
        />
      )}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Composer running={running} onSend={send} onStop={stop} />
    </KeyboardScreen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 12 },
  empty: { fontSize: 16, color: '#666' },
  banner: { textAlign: 'center', paddingVertical: 4, backgroundColor: '#fff3cd', color: '#6b5200', fontSize: 13 },
  error: { color: '#b91c1c', paddingHorizontal: 12, paddingVertical: 6, fontSize: 14 },
});
