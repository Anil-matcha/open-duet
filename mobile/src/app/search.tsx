import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { KeyboardScreen } from '@/components/keyboard-screen';
import { highlightPieces, hitLabel, hitTarget, MIN_SEARCH_CHARS, type SearchHit } from '@/lib/search';
import { relativeTime } from '@/lib/time';
import { useSearch } from '@/lib/use-search';
import { radius, useStyles, useTheme, type Palette } from '@/lib/theme';

function Hit({ hit, onOpen }: { hit: SearchHit; onOpen: () => void }) {
  const styles = useStyles(createStyles);
  const title = hit.thread_title || 'New conversation';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${hitLabel(hit)}`} style={styles.row} onPress={onOpen}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {[hitLabel(hit), hit.archived ? 'Archived' : '', relativeTime(hit.at)].filter(Boolean).join(' · ')}
      </Text>
      <Text style={styles.snippet} numberOfLines={4}>
        {highlightPieces(hit.snippet, hit.highlights).map((piece, index) => (
          <Text key={index} style={piece.match ? styles.match : undefined}>
            {piece.text}
          </Text>
        ))}
      </Text>
    </Pressable>
  );
}

export default function Search() {
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const { status, hits, hasMore, loadingMore, error, loadMore, tryAgain } = useSearch(query);

  const empty =
    status === 'short' ? (
      <Text style={styles.hint}>Type at least {MIN_SEARCH_CHARS} letters to search your conversations.</Text>
    ) : status === 'loading' ? (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    ) : status === 'error' ? (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
        <Pressable accessibilityRole="button" style={styles.retry} onPress={tryAgain}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    ) : (
      <Text style={styles.hint}>No conversations match “{query.trim()}”.</Text>
    );

  return (
    <KeyboardScreen>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Search conversations"
        placeholderTextColor={theme.muted}
        accessibilityLabel="Search conversations"
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
      <FlatList
        testID="search-results"
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        // Dragging the results closes the keyboard, so none of them stays behind it.
        keyboardDismissMode="on-drag"
        data={status === 'ready' || (status === 'loading' && hits.length > 0) ? hits : []}
        keyExtractor={(hit, index) => `${hit.thread_id}:${hit.seq ?? 't'}:${index}`}
        renderItem={({ item }) => <Hit hit={item} onOpen={() => router.push(hitTarget(item))} />}
        ListEmptyComponent={empty}
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={styles.more} />
          ) : status === 'ready' && error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : undefined
        }
      />
    </KeyboardScreen>
  );
}

const createStyles = (p: Palette) =>
  StyleSheet.create({
    input: { margin: 12, borderWidth: 1, borderColor: p.inputBorder, borderRadius: radius.field, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: p.text },
    list: { flex: 1, minHeight: 0 },
    center: { alignItems: 'center', marginTop: 40, gap: 12 },
    hint: { textAlign: 'center', marginTop: 40, paddingHorizontal: 24, fontSize: 16, color: p.muted },
    error: { color: p.danger, textAlign: 'center', paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
    retry: { borderWidth: 1, borderColor: p.accentText, borderRadius: radius.field, paddingHorizontal: 16, paddingVertical: 10 },
    retryText: { color: p.accentText, fontSize: 16, fontWeight: '600' },
    more: { marginVertical: 16 },
    row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    title: { fontSize: 16, fontWeight: '600', color: p.text },
    meta: { fontSize: 13, color: p.muted, marginTop: 2 },
    snippet: { fontSize: 15, color: p.text, marginTop: 4 },
    match: { fontWeight: '700', backgroundColor: p.surfaceStrong },
  });
