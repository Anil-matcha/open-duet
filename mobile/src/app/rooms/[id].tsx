import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { RoomMessage } from '@/components/room-message';
import { mentionNames, workingNames, type RoomItem } from '@/lib/rooms';
import { useStyles, type Palette } from '@/lib/theme';
import { useRoom } from '@/lib/use-room';

const BANNER: Record<string, string> = { connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
// A room's message is at most this long on the server.
const MESSAGE_LIMIT = 8000;

export default function RoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { room, items, approvals, connection, error, loaded, busy, send, stop, answer } = useRoom(Number(id));
  const styles = useStyles(createStyles);
  const list = useRef<FlatList<RoomItem>>(null);
  const stuckToEnd = useRef(true);
  const working = workingNames(room);

  return (
    <KeyboardScreen>
      <Stack.Screen options={{ title: room?.name || 'Room' }} />
      {BANNER[connection] ? <Text style={styles.banner}>{BANNER[connection]}</Text> : null}
      {!loaded ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No messages yet. Tag an agent with @ to get its attention.</Text>
        </View>
      ) : (
        <FlatList
          ref={list}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          onLayout={() => {
            if (stuckToEnd.current) list.current?.scrollToEnd({ animated: false });
          }}
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => <RoomMessage item={item} />}
          contentContainerStyle={styles.content}
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
      {approvals.length > 0 ? (
        <ApprovalCard
          key={approvals[0].approvalId}
          item={approvals[0]}
          agentName={approvals[0].agentName}
          waiting={approvals.length}
          onAnswer={(decision) => answer(approvals[0], decision)}
        />
      ) : null}
      {busy ? (
        <View style={styles.working}>
          <Text style={styles.workingText} numberOfLines={1}>
            {working.length ? `${working.join(', ')} working…` : 'Working…'}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => void stop()}>
            <Text style={styles.stop}>Stop</Text>
          </Pressable>
        </View>
      ) : null}
      <Composer running={false} onSend={(text) => send(text)} onStop={stop} mentions={mentionNames(room)} maxLength={MESSAGE_LIMIT} />
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    list: { flex: 1, minHeight: 0 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    content: { padding: 12 },
    empty: { fontSize: 16, color: p.muted, textAlign: 'center' },
    banner: { textAlign: 'center', paddingVertical: 4, backgroundColor: p.warnBackground, color: p.warnText, fontSize: 13 },
    error: { color: p.danger, paddingHorizontal: 12, paddingVertical: 6, fontSize: 14 },
    working: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: p.surface },
    workingText: { flex: 1, color: p.muted, fontSize: 13 },
    stop: { color: p.danger, fontSize: 15, fontWeight: '700', paddingLeft: 12 },
  });
