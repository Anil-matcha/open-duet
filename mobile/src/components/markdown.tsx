import { useMemo } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { parseMarkdown, type Align, type Span } from '@/lib/markdown';
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

const spanText = (spans: Span[]) => spans.map((span) => span.text).join('');

/** Width of each column from its longest cell, scaled with the person's text size. Long cells wrap. */
export function columnWidths(header: Span[][], rows: Span[][][], fontScale: number): number[] {
  return header.map((_, column) => {
    const longest = Math.max(spanText(header[column]).length, ...rows.map((row) => spanText(row[column]).length));
    return Math.round(Math.min(240, Math.max(72, longest * 8.5 + 24)) * Math.max(1, fontScale));
  });
}

// Wider than the screen is fine: the table scrolls sideways, so no column is ever cut off.
function Table({ header, rows, align }: { header: Span[][]; rows: Span[][][]; align: Align[] }) {
  const styles = useStyles(createStyles);
  const { fontScale } = useWindowDimensions();
  const widths = columnWidths(header, rows, fontScale);
  const line = (cells: Span[][], head: boolean) =>
    cells.map((spans, column) => (
      <View key={column} style={[styles.cell, head && styles.headCell, { width: widths[column] }]}>
        <Text selectable style={[styles.text, styles.cellText, head && styles.bold, { textAlign: align[column] }]}>
          <Spans spans={spans} />
        </Text>
      </View>
    ));
  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
      <View style={styles.table}>
        <View style={styles.row}>{line(header, true)}</View>
        {rows.map((row, index) => (
          <View key={index} style={styles.row}>
            {line(row, false)}
          </View>
        ))}
      </View>
    </ScrollView>
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
          case 'table':
            return <Table key={index} header={block.header} rows={block.rows} align={block.align} />;
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
    table: { borderTopWidth: StyleSheet.hairlineWidth, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: p.border },
    row: { flexDirection: 'row' },
    cell: { padding: 6, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: p.border },
    headCell: { backgroundColor: p.surfaceStrong },
    cellText: { fontSize: 14 },
  });
