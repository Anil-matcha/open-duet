import { Stack, useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Field, FormInput, PickerField, RadioGroup, SectionTitle, type Option } from '@/components/form';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { MemberPicker } from '@/components/member-picker';
import { Text } from '@/components/text';
import { canManageAgents, type Agent } from '@/lib/agents';
import { describeApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  BULLETIN_MAX,
  describeRoomError,
  draftFromRoom,
  EMPTY_ROOM_DRAFT,
  hasRoomErrors,
  isRoomDirty,
  MEMBERS_MAX,
  RESPONDER_OPTIONS,
  ROOM_NAME_MAX,
  toggleMember,
  toRoomCreateBody,
  toRoomUpdateBody,
  validateRoomDraft,
  type ResponderKind,
  type RoomDraft,
} from '@/lib/room-draft';
import { useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

// Create a room, or change one (`/room-settings?id=new`, `?id=<room>`). The fields and words are the web's. A room holds
// nothing that loosens anything: its members keep their own approvals.
export default function RoomSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const creating = id === 'new';
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const { state } = useAuth();
  const allowed = state.status === 'paired' && canManageAgents(state.scopes);

  const [original, setOriginal] = useState<RoomDraft | null>(creating ? EMPTY_ROOM_DRAFT : null);
  const [draft, setDraft] = useState<RoomDraft>(EMPTY_ROOM_DRAFT);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [nameTaken, setNameTaken] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    if (!api || !allowed) return;
    let cancelled = false;
    (async () => {
      try {
        const [list, room] = await Promise.all([api.listAgents(), creating ? null : api.getRoom(Number(id))]);
        if (cancelled) return;
        if (room) {
          const next = draftFromRoom(room);
          setOriginal(next);
          setDraft(next);
          // Archived agents are not offered, except one that is already in the room.
          const inRoom = room.members.map((member) => member.agent_id);
          const missing = room.members.filter((member) => !list.some((agent) => agent.id === member.agent_id));
          setAgents([...list, ...missing.map((member): Agent => ({ id: member.agent_id, name: member.name, title: null, description: null, provider: '', model: null, approval_mode: 'ask', pinned: false }))].filter((agent) => !agent.archived_at || inRoom.includes(agent.id)));
        } else {
          setAgents(list.filter((agent) => !agent.archived_at));
        }
      } catch (err) {
        if (!cancelled) setLoadError(describeApiError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, allowed, creating, id]);

  const dirty = original !== null && isRoomDirty(draft, original);
  usePreventRemove(dirty && !saving && !discarding, ({ repeat }) => {
    Alert.alert('Discard unsaved changes?', undefined, [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard changes',
        style: 'destructive',
        onPress: () => {
          setDiscarding(true);
          repeat();
        },
      },
    ]);
  });

  const errors = validateRoomDraft(draft);
  const chosen = agents.filter((agent) => draft.member_ids.includes(agent.id));
  const responderOptions: Option<string>[] = chosen.map((agent) => ({ value: String(agent.id), label: agent.name }));
  const responder = chosen.find((agent) => agent.id === draft.default_responder_agent_id);

  const save = async () => {
    setShowErrors(true);
    setProblem(null);
    if (!api || hasRoomErrors(errors) || !original) return;
    setSaving(true);
    try {
      if (creating) {
        const room = await api.createRoom(toRoomCreateBody(draft));
        setDiscarding(true);
        router.replace({ pathname: '/rooms/[id]', params: { id: String(room.id) } });
        return;
      }
      const body = toRoomUpdateBody(draft, original);
      if (Object.keys(body).length > 0) await api.updateRoom(Number(id), body);
      router.back();
    } catch (err) {
      const failure = describeRoomError(err);
      if (failure.field === 'name') setNameTaken(failure.message);
      else setProblem(failure.message);
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>This phone was not paired to manage rooms. Pair it again with a “Chat, files and agents” code.</Text>
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          {loadError}
        </Text>
      </View>
    );
  }
  if (!original) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardScreen>
      <Stack.Screen options={{ title: creating ? 'New room' : 'Room settings' }} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.muted}>Members share a conversation and answer one at a time. Their tools still require your approval.</Text>

        <Field label="Room name" error={(showErrors ? errors.name : null) ?? nameTaken}>
          <FormInput
            accessibilityLabel="Room name"
            value={draft.name}
            onChangeText={(text) => {
              setDraft((current) => ({ ...current, name: text }));
              setNameTaken(null);
            }}
            maxLength={ROOM_NAME_MAX}
            autoFocus={creating}
            invalid={!!(showErrors && errors.name) || !!nameTaken}
          />
        </Field>

        <SectionTitle>Members</SectionTitle>
        <Field label={`Choose up to ${MEMBERS_MAX} agents`} counter={`${draft.member_ids.length} of ${MEMBERS_MAX}`} helper="They answer one at a time." error={showErrors ? errors.members : null}>
          <MemberPicker agents={agents} selected={draft.member_ids} onToggle={(agentId) => setDraft((current) => toggleMember(current, agentId))} />
        </Field>
        {!creating ? <Text style={styles.muted}>Removing a member skips their queued replies. A member who is working must be stopped first. Adding them again keeps their history.</Text> : null}

        <SectionTitle>Instructions</SectionTitle>
        <Field label="Shared instructions" helper="Shown to every member of the room." counter={`${draft.bulletin.length.toLocaleString()} / ${BULLETIN_MAX.toLocaleString()}`} error={showErrors ? errors.bulletin : null}>
          <FormInput accessibilityLabel="Shared instructions" value={draft.bulletin} onChangeText={(text) => setDraft((current) => ({ ...current, bulletin: text }))} lines={4} maxLength={BULLETIN_MAX} />
        </Field>

        <SectionTitle>Replies</SectionTitle>
        <Field label="Who answers without a tag?">
          <RadioGroup
            label="Who answers without a tag"
            options={RESPONDER_OPTIONS}
            value={draft.default_responder_kind}
            onChange={(kind: ResponderKind) => setDraft((current) => ({ ...current, default_responder_kind: kind }))}
          />
        </Field>
        {draft.default_responder_kind === 'member' ? (
          <Field label="Default responder" error={showErrors ? errors.responder : null}>
            <PickerField
              label="Default responder"
              title="Default responder"
              valueLabel={responder?.name ?? 'Choose a member…'}
              options={responderOptions}
              value={responder ? String(responder.id) : null}
              onChange={(value) => setDraft((current) => ({ ...current, default_responder_agent_id: Number(value) }))}
              disabled={chosen.length === 0}
            />
          </Field>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {problem ? (
          <Text style={styles.error} accessibilityRole="alert">
            {problem}
          </Text>
        ) : null}
        <Button label={creating ? 'Create room' : 'Save room'} onPress={save} busy={saving} disabled={!dirty && !creating} />
      </View>
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    container: { padding: 16, paddingBottom: 24 },
    muted: { fontSize: 13, color: p.muted },
    error: { fontSize: 14, color: p.danger },
    footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border, backgroundColor: p.background, gap: 6 },
  });
