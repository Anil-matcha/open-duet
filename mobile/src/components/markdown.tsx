import { useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { parseMarkdown, type Span } from '@/lib/markdown';
import { useStyles, type Palette } from '@/lib/theme';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const HEADING_SIZE = [0, 22, 20, 18, 17, 16, 16];

function Spans({ spans }: { spans: Span[] }) {
  const styles = useStyles(createStyles);
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
  const styles = useStyles(createStyles);
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

const createStyles = (p: Palette) =>
  StyleSheet.create({
    root: { gap: 8 },
    text: { color: p.text, fontSize: 16 },
    bold: { fontWeight: '700' },
    italic: { fontStyle: 'italic' },
    link: { color: p.accentText, textDecorationLine: 'underline' },
    inlineCode: { fontFamily: MONO, backgroundColor: p.surfaceStrong },
    codeBlock: { backgroundColor: p.surfaceStrong, borderRadius: 8, padding: 8 },
    codeText: { fontFamily: MONO, fontSize: 13, color: p.text },
    quote: { borderLeftWidth: 3, borderLeftColor: p.quoteBar, paddingLeft: 8 },
    list: { gap: 4 },
    item: { flexDirection: 'row', gap: 6 },
    itemText: { flex: 1 },
  });
