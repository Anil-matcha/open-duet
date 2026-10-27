import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type Props = {
  running: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
};

export function Composer({ running, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const canSend = text.trim().length > 0 && !running && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    // The message is cleared only once the server accepted it, so a failure never loses what was typed.
    if (await onSend(text.trim())) setText('');
    setSending(false);
  };

  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message"
        multiline
        maxLength={20_000}
        accessibilityLabel="Message"
      />
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
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#bbb' },
  input: { flex: 1, maxHeight: 140, borderWidth: 1, borderColor: '#999', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, fontSize: 16 },
  button: { backgroundColor: '#0a7ea4', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  stop: { backgroundColor: '#b91c1c' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
