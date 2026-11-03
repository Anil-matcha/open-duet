import { Stack, useLocalSearchParams, usePreventRemove, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Button, Field, FormInput, PickerField, RadioGroup, SectionTitle, SwitchRow, type Option } from '@/components/form';
import { KeyboardScreen } from '@/components/keyboard-screen';
import { Text } from '@/components/text';
import {
  byteLength,
  describeSaveError,
  draftFromAgent,
  EMPTY_DRAFT,
  hasErrors,
  INSTRUCTIONS_MAX_BYTES,
  isDirty,
  NAME_MAX,
  DESCRIPTION_MAX,
  SAVE_IMPACT_NOTES,
  TITLE_MAX,
  toCreateBody,
  toUpdateBody,
  validateDraft,
  type AgentDraft,
} from '@/lib/agent-draft';
import { APPROVAL_OPTIONS, canManageAgents, type ApprovalMode } from '@/lib/agents';
import { useAuth } from '@/lib/auth-context';
import { describeApiError } from '@/lib/api';
import { engineLabel, engineProblem, findEngine, modelLabel, type Engine } from '@/lib/engines';
import { useStyles, type Palette } from '@/lib/theme';
import { useApi } from '@/lib/use-api';

const DEFAULT = '__default__';
const NONE = '__none__';

// Create an agent, or edit one (`/agents/new`, `/agents/<id>`). The fields and words are the web editor's. A phone can
// make an agent that asks first or only plans; "Accept edits", the workspace folder, connected apps and the lead role
// stay in the web app, and the server refuses them from a phone.
export default function AgentEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const creating = id === 'new';
  const api = useApi();
  const router = useRouter();
  const styles = useStyles(createStyles);
  const { state } = useAuth();
  const allowed = state.status === 'paired' && canManageAgents(state.scopes);

  const [original, setOriginal] = useState<AgentDraft | null>(creating ? EMPTY_DRAFT : null);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [nameTaken, setNameTaken] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!api || !allowed) return;
    let cancelled = false;
    (async () => {
      try {
        const [list, agent] = await Promise.all([api.listEngines(), creating ? null : api.getAgent(Number(id))]);
        if (cancelled) return;
        setEngines(list);
        if (agent) {
          const next = draftFromAgent(agent);
          setOriginal(next);
          setDraft(next);
          setAgentId(agent.id);
        } else {
          // A new agent starts on the first engine that is ready, else on Claude as the web does.
          const ready = list.find((engine) => engine.available);
          if (ready && ready.id !== EMPTY_DRAFT.provider && !list.some((engine) => engine.id === EMPTY_DRAFT.provider && engine.available)) {
            setDraft((current) => ({ ...current, provider: ready.id }));
            setOriginal((current) => (current ? { ...current, provider: ready.id } : current));
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(describeApiError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, allowed, creating, id]);

  const dirty = original !== null && isDirty(draft, original);
  // Leaving with unsaved changes asks first. While a save runs nothing is held back, so going back after it is not asked.
  const [discarding, setDiscarding] = useState(false);
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

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const engine = findEngine(engines, draft.provider);
  const fallbackEngine = draft.fallback_provider ? findEngine(engines, draft.fallback_provider) : undefined;

  const engineOptions: Option<string>[] = engines.map((entry) => ({ value: entry.id, label: entry.label, note: engineProblem(entry), disabled: !entry.available && entry.id !== draft.provider }));
  if (!engine) engineOptions.push({ value: draft.provider, label: draft.provider, note: 'Not on this server', disabled: true });

  const modelOptions = (of: Engine | undefined, current: string | null): Option<string>[] => {
    const options: Option<string>[] = [{ value: DEFAULT, label: modelLabel(of, null) }];
    for (const model of of?.models ?? []) options.push({ value: model.id, label: model.label });
    if (current !== null && !of?.models.some((model) => model.id === current)) options.push({ value: current, label: modelLabel(of, current) });
    return options;
  };

  const fallbackOptions: Option<string>[] = [{ value: NONE, label: 'None' }, ...engines.filter((entry) => entry.id !== draft.provider).map((entry) => ({ value: entry.id, label: entry.label, note: engineProblem(entry), disabled: !entry.available && entry.id !== draft.fallback_provider }))];

  // "Accept edits" is shown, never offered: the server refuses it from a phone. An agent already on it can be moved off it.
  const approvalOptions: Option<ApprovalMode>[] = APPROVAL_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    disabled: option.value === 'accept_edits',
    note: option.value === 'accept_edits' ? 'Set in the web app. Moving this agent to another mode here cannot be undone from the phone.' : null,
  }));

  const errors = validateDraft(draft);
  const save = async () => {
    setShowErrors(true);
    setProblem(null);
    if (!api || hasErrors(errors) || !original) return;
    setSaving(true);
    try {
      if (creating) await api.createAgent(toCreateBody(draft));
      else {
        const body = toUpdateBody(draft, original);
        if (Object.keys(body).length > 0 && agentId !== null) await api.updateAgent(agentId, body);
      }
      router.back();
    } catch (err) {
      const failure = describeSaveError(err);
      if (failure.field === 'name') setNameTaken(failure.message);
      else setProblem(failure.message);
      setSaving(false);
    }
  };

  if (!allowed) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>This phone was not paired to manage agents. Pair it again with a “Chat, files and agents” code.</Text>
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

  const instructionBytes = byteLength(draft.instructions);
  const noteForEngine = engine ? null : 'This server no longer lists that engine.';

  return (
    <KeyboardScreen>
      <Stack.Screen options={{ title: creating ? 'New agent' : 'Edit agent' }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {!creating && agentId !== null ? (
          <View style={styles.identity}>
            <Avatar agentId={agentId} name={draft.name} />
            <Text style={styles.muted}>The picture and colour come from the agent’s name.</Text>
          </View>
        ) : null}

        <SectionTitle>Basics</SectionTitle>
        <Field label="Name" error={(showErrors ? errors.name : null) ?? nameTaken}>
          <FormInput
            accessibilityLabel="Name"
            value={draft.name}
            onChangeText={(text) => {
              set('name', text);
              setNameTaken(null);
            }}
            placeholder="Code reviewer"
            maxLength={NAME_MAX}
            autoFocus={creating}
            invalid={!!(showErrors && errors.name) || !!nameTaken}
            returnKeyType="next"
          />
        </Field>
        <Field label="Title" error={showErrors ? errors.title : null}>
          <FormInput accessibilityLabel="Title" value={draft.title} onChangeText={(text) => set('title', text)} placeholder="Reviews pull requests before merge" maxLength={TITLE_MAX} />
        </Field>
        <Field label="Description" helper="For you: what this agent is for. Not sent to the model." error={showErrors ? errors.description : null}>
          <FormInput accessibilityLabel="Description" value={draft.description} onChangeText={(text) => set('description', text)} lines={3} maxLength={DESCRIPTION_MAX} />
        </Field>
        <Field
          label="Instructions"
          helper="How this agent should behave. Added to every conversation it starts. Do not paste passwords or keys here."
          counter={`${instructionBytes.toLocaleString()} / ${INSTRUCTIONS_MAX_BYTES.toLocaleString()} bytes`}
          error={showErrors || instructionBytes > INSTRUCTIONS_MAX_BYTES ? errors.instructions : null}
        >
          <FormInput accessibilityLabel="Instructions" value={draft.instructions} onChangeText={(text) => set('instructions', text)} lines={8} invalid={instructionBytes > INSTRUCTIONS_MAX_BYTES} />
        </Field>

        <SectionTitle>Model</SectionTitle>
        <Field label="Engine" helper={noteForEngine ?? undefined}>
          <PickerField
            label="Engine"
            title="Engine"
            valueLabel={engineLabel(engines, draft.provider)}
            options={engineOptions}
            value={draft.provider}
            onChange={(next) =>
              setDraft((current) => ({
                ...current,
                provider: next,
                model: null,
                fallback_provider: current.fallback_provider === next ? null : current.fallback_provider,
                fallback_model: current.fallback_provider === next ? null : current.fallback_model,
              }))
            }
          />
          {engine && engineProblem(engine) ? <Text style={styles.note}>{engineProblem(engine)}</Text> : null}
        </Field>
        <Field label="Model" helper={engine?.customModels ? 'Choose a suggestion or enter a model ID.' : 'Leave the model unset to use the engine’s default.'}>
          <PickerField
            label="Model"
            title="Model"
            valueLabel={modelLabel(engine, draft.model)}
            options={modelOptions(engine, draft.model)}
            value={draft.model ?? DEFAULT}
            onChange={(next) => set('model', next === DEFAULT ? null : next)}
          />
          {engine?.customModels ? (
            <FormInput accessibilityLabel="Model ID" value={draft.model ?? ''} onChangeText={(text) => set('model', text.trim() ? text : null)} placeholder="Engine default" autoCapitalize="none" autoCorrect={false} maxLength={200} />
          ) : null}
        </Field>
        <Field label="Fallback engine" helper="When the engine refuses a message for a usage or rate limit before starting on it, the message goes to the fallback, if it can do everything the turn needs.">
          <PickerField
            label="Fallback engine"
            title="Fallback engine"
            valueLabel={draft.fallback_provider ? engineLabel(engines, draft.fallback_provider) : 'None'}
            options={fallbackOptions}
            value={draft.fallback_provider ?? NONE}
            onChange={(next) => setDraft((current) => ({ ...current, fallback_provider: next === NONE ? null : next, fallback_model: null }))}
          />
          {draft.fallback_provider ? (
            <PickerField
              label="Fallback model"
              title="Fallback model"
              valueLabel={modelLabel(fallbackEngine, draft.fallback_model)}
              options={modelOptions(fallbackEngine, draft.fallback_model)}
              value={draft.fallback_model ?? DEFAULT}
              onChange={(next) => set('fallback_model', next === DEFAULT ? null : next)}
            />
          ) : null}
          {showErrors && errors.fallback ? (
            <Text style={styles.error} accessibilityRole="alert">
              {errors.fallback}
            </Text>
          ) : null}
        </Field>

        <SectionTitle>Approvals</SectionTitle>
        <Field label="When this agent wants to act">
          <RadioGroup label="Approval mode" options={approvalOptions} value={draft.approval_mode} onChange={(next) => set('approval_mode', next)} />
        </Field>

        <SectionTitle>Memory</SectionTitle>
        <SwitchRow label="Use notes" helper="Load this agent’s notes into each conversation." value={draft.memory_enabled} onValueChange={(next) => set('memory_enabled', next)} />
        {creating ? (
          <Field label="Starter notes" helper="The agent’s first notes. It keeps them up to date itself.">
            <FormInput accessibilityLabel="Starter notes" value={draft.starter_notes} onChangeText={(text) => set('starter_notes', text)} lines={5} placeholder={'- The project uses pnpm\n- Releases go out on Fridays'} />
          </Field>
        ) : null}

        <Text style={styles.web}>The workspace folder, connected apps, skills, notes, computer and team lead role are set in the web app.</Text>
        {!creating ? (
          <View style={styles.impact}>
            <Text style={styles.impactTitle}>When you save</Text>
            {SAVE_IMPACT_NOTES.map((note) => (
              <Text key={note} style={styles.muted}>
                {note}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {problem ? (
          <Text style={styles.error} accessibilityRole="alert">
            {problem}
          </Text>
        ) : null}
        <Button label={creating ? 'Create agent' : 'Save'} onPress={save} busy={saving} disabled={!dirty && !creating} />
      </View>
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    container: { padding: 16, paddingBottom: 24 },
    identity: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    muted: { fontSize: 13, color: p.muted, flexShrink: 1 },
    note: { fontSize: 13, color: p.notice },
    error: { fontSize: 14, color: p.danger },
    web: { fontSize: 13, color: p.muted, marginTop: 24 },
    impact: { marginTop: 16, gap: 6 },
    impactTitle: { fontSize: 13, fontWeight: '600', color: p.text },
    footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border, backgroundColor: p.background, gap: 6 },
  });
