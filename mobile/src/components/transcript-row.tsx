import { Image, type ImageSourcePropType, StyleSheet, Text, View } from 'react-native';

import { Markdown } from '@/components/markdown';
import type { Attachment } from '@/lib/attachments';
import type { TranscriptItem } from '@/lib/transcript';
import { radius, useStyles, type Palette } from '@/lib/theme';

export type Row = TranscriptItem | { kind: 'typing'; key: string; text: string };

const APPROVAL_WORDS: Record<string, string> = {
  pending: 'Waiting for your approval',
  allowed: 'You allowed',
  denied: 'You denied',
  expired: 'Nobody answered',
  cancelled: 'Withdrawn',
};

const TOOL_MARKS: Record<string, string> = { running: '…', done: '✓', error: '✗', stopped: '–' };

type Props = {
  row: Row;
  /** Where an attached image is loaded from (it needs the bearer token); left out, images show as file chips. */
  attachmentSource?: (attachmentId: string) => ImageSourcePropType | undefined;
};

function Attachments({ files, source }: { files: Attachment[]; source: Props['attachmentSource'] }) {
  const styles = useStyles(createStyles);
  return (
    <View style={styles.files}>
      {files.map((file) => {
        const image = file.kind === 'image' ? source?.(file.id) : undefined;
        return image ? (
          <Image key={file.id} source={image} style={styles.thumb} accessibilityLabel={file.name} />
        ) : (
          <Text key={file.id} style={styles.fileChip} numberOfLines={1}>
            {file.name}
          </Text>
        );
      })}
    </View>
  );
}

export function TranscriptRow({ row, attachmentSource }: Props) {
  const styles = useStyles(createStyles);
  switch (row.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.user]}>
          {row.attachments.length > 0 ? <Attachments files={row.attachments} source={attachmentSource} /> : null}
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

const createStyles = (p: Palette) =>
  StyleSheet.create({
    bubble: { maxWidth: '88%', borderRadius: radius.card, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 },
    user: { alignSelf: 'flex-end', backgroundColor: p.accent },
    assistant: { alignSelf: 'flex-start', backgroundColor: p.surface },
    userText: { color: p.onAccent, fontSize: 16 },
    assistantText: { color: p.text, fontSize: 16 },
    files: { gap: 6, marginBottom: 6 },
    thumb: { width: 180, height: 180, borderRadius: radius.field, backgroundColor: '#ffffff33' },
    fileChip: { color: p.onAccent, fontSize: 13, backgroundColor: '#ffffff33', borderRadius: radius.field, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden' },
    muted: { color: p.muted, fontSize: 12, marginTop: 4 },
    line: { color: p.muted, fontSize: 13, marginVertical: 3, paddingHorizontal: 4 },
    approval: { alignSelf: 'stretch', borderWidth: 1, borderColor: p.warnBorder, backgroundColor: p.warnBackground, borderRadius: radius.field, padding: 10, marginVertical: 6 },
    approvalTitle: { color: p.warnText, fontSize: 13, fontWeight: '700', marginBottom: 2 },
  });
