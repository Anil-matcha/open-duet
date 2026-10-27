import { useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { parseMarkdown, type Span } from '@/lib/markdown';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const HEADING_SIZE = [0, 22, 20, 18, 17, 16, 16];

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={index}
          style={[span.bold && styles.bold, span.italic && styles.italic, span.code && styles.inlineCode, span.href ? styles.link : null]}
          // Opened by the system, never inside the app. A failure to open is not worth an error here.
          onPress={span.href ? () => void Linking.openURL(span.href!).catch(() => undefined) : undefined}
          accessibilityRole={span.href ? 'link' : undefined}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return (
              <Text key={index} accessibilityRole="header" style={[styles.text, styles.bold, { fontSize: HEADING_SIZE[block.level] }]}>
                <Spans spans={block.spans} />
              </Text>
            );
          case 'code':
            return (
              <View key={index} style={styles.codeBlock}>
                <Text selectable style={styles.codeText}>
                  {block.text}
                </Text>
              </View>
            );
          case 'quote':
            return (
              <View key={index} style={styles.quote}>
                <Text style={styles.text}>
                  <Spans spans={block.spans} />
                </Text>
              </View>
            );
          case 'list':
            return (
              <View key={index} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={styles.item}>
                    <Text style={styles.text}>{block.ordered ? `${itemIndex + 1}.` : '•'}</Text>
                    <Text style={[styles.text, styles.itemText]}>
                      <Spans spans={item} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          default:
            return (
              <Text key={index} selectable style={styles.text}>
                <Spans spans={block.spans} />
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  text: { color: '#111', fontSize: 16 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { color: '#0a6c8e', textDecorationLine: 'underline' },
  inlineCode: { fontFamily: MONO, backgroundColor: '#dfe4e8' },
  codeBlock: { backgroundColor: '#dfe4e8', borderRadius: 8, padding: 8 },
  codeText: { fontFamily: MONO, fontSize: 13, color: '#111' },
  quote: { borderLeftWidth: 3, borderLeftColor: '#9aa5ab', paddingLeft: 8 },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: 6 },
  itemText: { flex: 1 },
});
