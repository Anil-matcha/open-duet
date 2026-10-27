import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { MAX_ATTACHMENTS, type Attachment } from '@/lib/attachments';

type Props = {
  running: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  onStop: () => Promise<void>;
  /** Opens a picker and uploads the choice; left out, the composer has no attach button. */
  onAttach?: (kind: 'photo' | 'file', room: number) => Promise<Attachment[]>;
};

export function Composer({ running, onSend, onStop, onAttach }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const canSend = text.trim().length > 0 && !running && !sending && !uploading;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    // The message and its files are cleared only once the server accepted them, so a failure never loses them.
    if (await onSend(text.trim(), attached.map((file) => file.id))) {
      setText('');
      setAttached([]);
    }
    setSending(false);
  };

  const pick = async (kind: 'photo' | 'file') => {
    if (!onAttach) return;
    setUploading(true);
    try {
      const added = await onAttach(kind, MAX_ATTACHMENTS - attached.length);
      setAttached((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS));
    } finally {
      setUploading(false);
    }
  };

  const choose = () =>
    Alert.alert('Attach', undefined, [
      { text: 'Photo', onPress: () => void pick('photo') },
      { text: 'File', onPress: () => void pick('file') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <View style={styles.wrap}>
      {attached.length > 0 || uploading ? (
        <View style={styles.chips}>
          {attached.map((file) => (
            <View key={file.id} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {file.name}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={8} onPress={() => setAttached((current) => current.filter((other) => other.id !== file.id))}>
                <Text style={styles.chipRemove}>✕</Text>
              </Pressable>
            </View>
          ))}
          {uploading ? <ActivityIndicator accessibilityLabel="Uploading" /> : null}
        </View>
      ) : null}
      <View style={styles.bar}>
        {onAttach ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            style={[styles.attach, (uploading || attached.length >= MAX_ATTACHMENTS) && styles.disabled]}
            disabled={uploading || attached.length >= MAX_ATTACHMENTS}
            onPress={choose}>
            <Text style={styles.attachText}>+</Text>
          </Pressable>
        ) : null}
        <TextInput style={styles.input} value={text} onChangeText={setText} placeholder="Message" multiline maxLength={20_000} accessibilityLabel="Message" />
        {running ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop" style={[styles.button, styles.stop]} onPress={() => void onStop()}>
            <Text style={styles.buttonText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="Send" style={[styles.button, !canSend && styles.disabled]} disabled={!canSend} onPress={send}>
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#bbb' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '60%', backgroundColor: '#eceff1', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 13, color: '#111', flexShrink: 1 },
  chipRemove: { fontSize: 13, color: '#555' },
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8 },
  attach: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  attachText: { fontSize: 28, color: '#0a7ea4', lineHeight: 30 },
  input: { flex: 1, maxHeight: 140, borderWidth: 1, borderColor: '#999', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 16 },
  button: { backgroundColor: '#0a7ea4', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  stop: { backgroundColor: '#b91c1c' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
