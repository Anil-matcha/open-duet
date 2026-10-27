import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { approvalFields, previewValue } from '@/lib/approval-text';
import type { TranscriptItem } from '@/lib/transcript';

type Approval = Extract<TranscriptItem, { kind: 'approval' }>;

type Props = {
  item: Approval;
  /** How many are waiting in all, this one included. */
  waiting: number;
  onAnswer: (decision: 'allow' | 'deny') => Promise<boolean>;
};

function Field({ name, value }: { name: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const { text, cut } = previewValue(value);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldName}>{name}</Text>
      <Text style={styles.fieldValue} selectable>
        {expanded || !cut ? value : `${text}…`}
      </Text>
      {cut ? (
        <Pressable accessibilityRole="button" onPress={() => setExpanded((open) => !open)}>
          <Text style={styles.link}>{expanded ? 'Show less' : 'Show all'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The oldest approval waiting for an answer, pinned above the composer so it cannot scroll out of sight.
export function ApprovalCard({ item, waiting, onAnswer }: Props) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null);
  const fields = approvalFields(item.input);

  const answer = async (decision: 'allow' | 'deny') => {
    if (sending || sent) return;
    setSending(true);
    // Once the server took the answer, the card waits for the stream to report it resolved.
    if (await onAnswer(decision)) setSent(decision);
    setSending(false);
  };

  return (
    <View style={styles.card} accessibilityLabel="Approval needed">
      <Text style={styles.title}>
        Your agent wants to use <Text style={styles.mono}>{item.tool}</Text>
        {waiting > 1 ? `  (1 of ${waiting} waiting)` : ''}
      </Text>
      <Text style={styles.note}>It will not run until you allow it.</Text>
      {item.summary ? <Text style={styles.summary}>{item.summary}</Text> : null}
      {fields.map((field) => (
        <Field key={field.name} name={field.name} value={field.value} />
      ))}
      {sent ? (
        <Text style={styles.note}>{sent === 'allow' ? 'Allowed.' : 'Denied.'} Waiting for your server…</Text>
      ) : (
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" accessibilityLabel="Allow" style={[styles.button, styles.allow, sending && styles.disabled]} disabled={sending} onPress={() => answer('allow')}>
            <Text style={styles.buttonText}>Allow</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Deny" style={[styles.button, styles.deny, sending && styles.disabled]} disabled={sending} onPress={() => answer('deny')}>
            <Text style={styles.denyText}>Deny</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#d9a400', backgroundColor: '#fff8e1', maxHeight: 360 },
  title: { fontSize: 15, fontWeight: '700', color: '#111' },
  mono: { fontFamily: 'monospace' },
  note: { fontSize: 13, color: '#6b5200', marginTop: 2 },
  summary: { fontSize: 15, color: '#111', marginTop: 8 },
  field: { marginTop: 8 },
  fieldName: { fontSize: 12, color: '#6b5200' },
  fieldValue: { fontSize: 14, color: '#111', fontFamily: 'monospace' },
  link: { fontSize: 13, color: '#0a7ea4', paddingVertical: 4 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  allow: { backgroundColor: '#0a7ea4' },
  deny: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#b91c1c' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  denyText: { color: '#b91c1c', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
