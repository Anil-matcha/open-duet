import { useCallback, useEffect, useRef, useState } from 'react';

import { describeApiError } from './api';
import { MIN_SEARCH_CHARS, type SearchHit } from './search';
import { useApi } from './use-api';

const DEBOUNCE_MS = 350;

/** What the last answer was for (`key`), so an answer to an older query is never shown as the current one. */
type Settled = { key: string; hits: SearchHit[]; hasMore: boolean; loadingMore: boolean; error: string | null; failed: boolean };

/**
 * Searches as the person types (after a short pause) and pages further results in.
 * `short`: not enough typed yet. `loading`: the answer for this query has not arrived; any earlier hits stay shown.
 */
export function useSearch(query: string) {
  const api = useApi();
  const text = query.trim();
  const [retry, setRetry] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const nextOffset = useRef<number | null>(null);
  // Bumped for every new query, so a late answer to an earlier one is ignored.
  const generation = useRef(0);

  const short = !api || text.length < MIN_SEARCH_CHARS;
  const key = `${text}#${retry}`;

  useEffect(() => {
    const mine = ++generation.current;
    nextOffset.current = null;
    if (!api || text.length < MIN_SEARCH_CHARS) return;
    const timer = setTimeout(() => {
      api
        .searchConversations(text)
        .then((page) => {
          if (generation.current !== mine) return;
          nextOffset.current = page.nextOffset;
          setSettled({ key: `${text}#${retry}`, hits: page.hits, hasMore: page.hasMore, loadingMore: false, error: null, failed: false });
        })
        .catch((err) => {
          if (generation.current !== mine) return;
          setSettled({ key: `${text}#${retry}`, hits: [], hasMore: false, loadingMore: false, error: describeApiError(err), failed: true });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, text, retry]);

  const loadMore = useCallback(() => {
    const offset = nextOffset.current;
    const mine = generation.current;
    if (!api || offset === null) return;
    // One request at a time: the offset is cleared until the answer says where the next page starts.
    nextOffset.current = null;
    const update = (change: (current: Settled) => Settled) => setSettled((current) => (current && current.key === key ? change(current) : current));
    update((current) => ({ ...current, loadingMore: true }));
    api
      .searchConversations(text, offset)
      .then((page) => {
        if (generation.current !== mine) return;
        nextOffset.current = page.nextOffset;
        update((current) => ({ ...current, hits: [...current.hits, ...page.hits], hasMore: page.hasMore, loadingMore: false, error: null }));
      })
      .catch((err) => {
        if (generation.current !== mine) return;
        // Keep what is shown and let the person try the same page again.
        nextOffset.current = offset;
        update((current) => ({ ...current, loadingMore: false, error: describeApiError(err) }));
      });
  }, [api, text, key]);

  const tryAgain = useCallback(() => setRetry((count) => count + 1), []);

  const current = settled && settled.key === key ? settled : null;
  const status = short ? 'short' : current ? (current.failed ? 'error' : 'ready') : 'loading';
  return {
    status,
    hits: short ? [] : (current ?? settled)?.hits ?? [],
    hasMore: current?.hasMore ?? false,
    loadingMore: current?.loadingMore ?? false,
    error: current?.error ?? null,
    loadMore,
    tryAgain,
  };
}
