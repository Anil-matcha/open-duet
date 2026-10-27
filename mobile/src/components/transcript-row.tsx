import { StyleSheet, Text, View } from 'react-native';

import { Markdown } from '@/components/markdown';
import type { TranscriptItem } from '@/lib/transcript';

export type Row = TranscriptItem | { kind: 'typing'; key: string; text: string };

const APPROVAL_WORDS: Record<string, string> = {
  pending: 'Waiting for your approval',
  allowed: 'You allowed',
  denied: 'You denied',
  expired: 'Nobody answered',
  cancelled: 'Withdrawn',
};

const TOOL_MARKS: Record<string, string> = { running: '…', done: '✓', error: '✗', stopped: '–' };

export function TranscriptRow({ row }: { row: Row }) {
  switch (row.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.user]}>
          <Text style={styles.userText}>{row.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.assistant]}>
          <Markdown text={row.text} />
          {row.incomplete ? <Text style={styles.muted}>(stopped before it finished)</Text> : null}
        </View>
      );
    case 'typing':
      return (
        <View style={[styles.bubble, styles.assistant]}>
          <Text style={styles.assistantText}>{row.text}</Text>
        </View>
      );
    case 'tool':
      return (
        <Text style={styles.line} numberOfLines={2}>
          {TOOL_MARKS[row.state]} {row.summary || row.name}
        </Text>
      );
    case 'approval':
      return (
        <View style={styles.approval}>
          <Text style={styles.approvalTitle}>{APPROVAL_WORDS[row.status] ?? row.status}</Text>
          <Text style={styles.assistantText} numberOfLines={3}>
            {row.summary || row.tool}
          </Text>
        </View>
      );
    case 'turn_end':
      return (
        <Text style={styles.line}>
          {row.status === 'failed' ? `The answer failed${row.error ? `: ${row.error}` : '.'}` : row.status === 'cancelled' ? 'Stopped.' : 'The answer was interrupted.'}
        </Text>
      );
    case 'note':
      return <Text style={styles.line}>{row.text}</Text>;
    default:
      return <Text style={styles.line}>An update this version of the app cannot show ({row.type}).</Text>;
  }
}

const styles = StyleSheet.create({
  bubble: { maxWidth: '88%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
  user: { alignSelf: 'flex-end', backgroundColor: '#0a7ea4' },
  assistant: { alignSelf: 'flex-start', backgroundColor: '#eceff1' },
  userText: { color: '#fff', fontSize: 16 },
  assistantText: { color: '#111', fontSize: 16 },
  muted: { color: '#666', fontSize: 12, marginTop: 4 },
  line: { color: '#555', fontSize: 13, marginVertical: 3, paddingHorizontal: 4 },
  approval: { alignSelf: 'stretch', borderWidth: 1, borderColor: '#d9a400', backgroundColor: '#fff8e1', borderRadius: 10, padding: 10, marginVertical: 6 },
  approvalTitle: { color: '#8a6d00', fontSize: 13, fontWeight: '700', marginBottom: 2 },
});
