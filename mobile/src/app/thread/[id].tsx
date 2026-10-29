import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { TranscriptRow, type Row } from '@/components/transcript-row';
import { rowKeyForSeq } from '@/lib/search';
import { pendingApprovals } from '@/lib/transcript';
import { useThread } from '@/lib/use-thread';
import { useStyles, type Palette } from '@/lib/theme';

const BANNER: Record<string, string> = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' };

export default function Thread() {
  const styles = useStyles(createStyles);
  // Opened from a search result: `seq` is the message that matched.
  const { id, seq } = useLocalSearchParams<{ id: string; seq?: string }>();
  const targetKey = rowKeyForSeq(seq);
  const { transcript, thread, connection, error, loaded, running, send, attach, attachmentSource, stop, answerApproval } = useThread(Number(id));
  const list = useRef<FlatList<Row>>(null);
  // A conversation opened at a search result stays there instead of following the end.
  const stuckToEnd = useRef(targetKey === null);
  const jumped = useRef(false);

  const waiting = pendingApprovals(transcript.items);
  const rows: Row[] = transcript.typing ? [...transcript.items, { kind: 'typing', key: 'typing', text: transcript.typing }] : transcript.items;

  const targetIndex = targetKey ? rows.findIndex((row) => row.key === targetKey) : -1;
  useEffect(() => {
    if (!targetKey || !loaded || jumped.current) return;
    jumped.current = true;
    // A message that is not in the transcript (it may be one the app does not draw) leaves the usual place: the end.
    if (targetIndex < 0) {
      stuckToEnd.current = true;
      list.current?.scrollToEnd({ animated: false });
      return;
    }
    list.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.15, animated: false });
  }, [targetKey, targetIndex, loaded]);

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
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          onLayout={() => {
            if (stuckToEnd.current) list.current?.scrollToEnd({ animated: false });
          }}
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => (
            <View style={item.key === targetKey ? styles.target : undefined}>
              <TranscriptRow row={item} attachmentSource={attachmentSource} />
            </View>
          )}
          // Rows further down are not measured yet: go near, then to the row itself.
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.15, animated: false }), 100);
          }}
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
    list: { flex: 1, minHeight: 0 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 12 },
    target: { borderLeftWidth: 3, borderLeftColor: p.accentText },
    empty: { fontSize: 16, color: p.muted },
    banner: { textAlign: 'center', paddingVertical: 4, backgroundColor: p.warnBackground, color: p.warnText, fontSize: 13 },
    error: { color: p.danger, paddingHorizontal: 12, paddingVertical: 6, fontSize: 14 },
  });
