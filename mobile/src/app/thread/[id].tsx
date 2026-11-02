import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/text';
import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { ConversationTitle } from '@/components/conversation-title';
import { JumpToLatest } from '@/components/jump-to-latest';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { TranscriptRow, type Row } from '@/components/transcript-row';
import { agentName, type Agent } from '@/lib/agents';
import { rowKeyForSeq } from '@/lib/search';
import { pendingApprovals } from '@/lib/transcript';
import { useApi } from '@/lib/use-api';
import { useThread } from '@/lib/use-thread';
import { touch, useStyles, useTheme, type Palette } from '@/lib/theme';

const BANNER: Record<string, string> = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' };

export default function Thread() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const router = useRouter();
  // Opened from a search result: `seq` is the message that matched.
  const { id, seq } = useLocalSearchParams<{ id: string; seq?: string }>();
  const targetKey = rowKeyForSeq(seq);
  const { transcript, thread, connection, error, loaded, running, send, attach, attachmentSource, stop, answerApproval } = useThread(Number(id));
  const list = useRef<FlatList<Row>>(null);
  // A conversation opened at a search result stays there instead of following the end.
  const stuckToEnd = useRef(targetKey === null);
  const jumped = useRef(false);
  // Shown while the reader is scrolled up from the newest message.
  const [away, setAway] = useState(false);
  // Only to put the agent's name in the header; without it the header shows the title alone.
  const api = useApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    api?.listAgents().then(setAgents, () => undefined);
  }, [api]);

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
      <Stack.Screen
        options={{
          title: thread?.title || 'Conversation',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Files in this conversation"
              hitSlop={8}
              style={{ minHeight: touch.min, minWidth: touch.min, justifyContent: 'center', alignItems: 'flex-end' }}
              onPress={() => router.push({ pathname: '/files/[id]', params: { id: String(id) } })}
            >
              <Text maxFontSizeMultiplier={1.3} style={{ color: theme.accentText, fontWeight: '500', fontSize: 16 }}>
                Files
              </Text>
            </Pressable>
          ),
          headerTitle: () => <ConversationTitle title={thread?.title || 'Conversation'} agentId={thread?.agent_id ?? null} agentName={agentName(agents, thread?.agent_id)} />,
        }}
      />
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
        <View style={styles.list}>
          <FlatList
            ref={list}
            testID="conversation-list"
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
              setAway(!stuckToEnd.current);
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (stuckToEnd.current) list.current?.scrollToEnd({ animated: true });
            }}
          />
          {away ? (
            <JumpToLatest
              onPress={() => {
                stuckToEnd.current = true;
                setAway(false);
                list.current?.scrollToEnd({ animated: true });
              }}
            />
          ) : null}
        </View>
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
