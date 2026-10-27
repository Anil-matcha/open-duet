import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { TranscriptRow, type Row } from '@/components/transcript-row';
import { pendingApprovals } from '@/lib/transcript';
import { useThread } from '@/lib/use-thread';
import { useStyles, type Palette } from '@/lib/theme';

const BANNER: Record<string, string> = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' };

export default function Thread() {
  const styles = useStyles(createStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transcript, thread, connection, error, loaded, running, send, attach, attachmentSource, stop, answerApproval } = useThread(Number(id));
  const list = useRef<FlatList<Row>>(null);
  const stuckToEnd = useRef(true);

  const waiting = pendingApprovals(transcript.items);
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
          renderItem={({ item }) => <TranscriptRow row={item} attachmentSource={attachmentSource} />}
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
      {waiting.length > 0 ? (
        <ApprovalCard key={waiting[0].approvalId} item={waiting[0]} waiting={waiting.length} onAnswer={(decision) => answerApproval(waiting[0].approvalId, decision)} />
      ) : null}
      <Composer running={running} onSend={send} onStop={stop} onAttach={attach} />
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 12 },
    empty: { fontSize: 16, color: p.muted },
    banner: { textAlign: 'center', paddingVertical: 4, backgroundColor: p.warnBackground, color: p.warnText, fontSize: 13 },
    error: { color: p.danger, paddingHorizontal: 12, paddingVertical: 6, fontSize: 14 },
  });
