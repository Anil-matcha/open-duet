import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Button, Field, FormInput, SectionTitle } from '@/components/form';
import { Text } from '@/components/text';
import { canManageAgents } from '@/lib/agents';
import { describeApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { describeRoomError, RESPONDER_OPTIONS } from '@/lib/room-draft';
import { roomBusy, workingNames, type Room } from '@/lib/rooms';
import { useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

// A room's shared instructions, who is in it and how replies are routed. A phone paired with "Chat, files and agents" can
// also hold or resume a member, open the room's settings and delete the room (asking for its name first).
export default function RoomDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const { state } = useAuth();
  const manage = state.status === 'paired' && canManageAgents(state.scopes);

  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setRoom(await api.getRoom(Number(id)));
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [api, id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const hold = async (agentId: number, held: boolean) => {
    if (!api || busy) return;
    setBusy(true);
    try {
      await api.holdRoomMember(Number(id), agentId, held);
      await load();
    } catch (err) {
      setError(describeRoomError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!api || !room || busy) return;
    setBusy(true);
    try {
      await api.deleteRoom(room.id);
      router.dismissTo('/rooms');
    } catch (err) {
      setError(describeRoomError(err).message);
      setBusy(false);
    }
  };

  if (!room) {
    return (
      <View style={styles.center}>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }

  const working = workingNames(room);
  const routing = RESPONDER_OPTIONS.find((option) => option.value === room.default_responder_kind);
  const responder = room.default_responder_kind === 'member' ? room.members.find((member) => member.agent_id === room.default_responder_agent_id) : undefined;

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: room.name }} />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <SectionTitle>Shared instructions</SectionTitle>
      <Text style={styles.body}>{room.bulletin?.trim() ? room.bulletin : 'None.'}</Text>

      <SectionTitle>Replies</SectionTitle>
      <Text style={styles.body}>
        {routing?.label ?? 'Only tagged members'}
        {responder ? `: ${responder.name}` : ''}
      </Text>
      {routing ? <Text style={styles.muted}>{routing.description}</Text> : null}

      <SectionTitle>Members</SectionTitle>
      {roomBusy(room) ? <Text style={styles.muted}>{working.length ? `${working.join(', ')} working…` : 'Working…'}</Text> : null}
      {room.members.map((member) => (
        <View key={member.agent_id} style={styles.member}>
          <Avatar agentId={member.agent_id} name={member.name} size="sm" />
          <View style={styles.memberText}>
            <Text style={styles.name} numberOfLines={1}>
              {member.name}
            </Text>
            {member.held ? <Text style={styles.muted}>Held: skipped until resumed</Text> : null}
          </View>
          {manage ? (
            <View style={styles.memberButton}>
              <Button label={member.held ? 'Resume' : 'Hold'} spoken={member.held ? `Resume ${member.name}` : `Hold ${member.name}`} kind="secondary" disabled={busy} onPress={() => hold(member.agent_id, !member.held)} />
            </View>
          ) : null}
        </View>
      ))}

      {manage ? (
        <>
          <SectionTitle>Manage</SectionTitle>
          <Button label="Room settings" kind="secondary" onPress={() => router.push({ pathname: '/room-settings', params: { id: String(room.id) } })} />
          {confirming ? (
            <View style={styles.confirm}>
              <Text style={styles.body}>Delete this room and its shared history? This cannot be undone.</Text>
              <Field label={`Type ${room.name} to confirm`}>
                <FormInput accessibilityLabel="Room name to confirm" value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} />
              </Field>
              <Button label="Delete room permanently" kind="danger" busy={busy} disabled={typed.trim() !== room.name} onPress={remove} />
              <Button
                label="Keep room"
                kind="secondary"
                onPress={() => {
                  setConfirming(false);
                  setTyped('');
                }}
              />
            </View>
          ) : (
            <Button label="Delete room…" kind="danger" onPress={() => setConfirming(true)} />
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    container: { padding: 16, paddingBottom: 32 },
    body: { fontSize: 15, color: p.text, marginTop: 8 },
    muted: { fontSize: 13, color: p.muted, marginTop: 4 },
    error: { fontSize: 14, color: p.danger },
    member: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
    memberText: { flex: 1 },
    memberButton: { minWidth: 110 },
    name: { fontSize: 16, color: p.text },
    confirm: { marginTop: 8, gap: 4 },
  });
