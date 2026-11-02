// Conversation search on the phone: the shape the server returns and what the screen does with it.
// Plain TypeScript with no React Native imports, so it is easy to test.

export type SearchHit = {
  thread_id: number;
  thread_title: string | null;
  agent_id: number | null;
  archived: boolean;
  /** `title`, `user` or `assistant`; anything else is shown as a message. */
  kind: string;
  at: string;
  snippet: string;
  /** `[start, length]` pairs into `snippet`, one per matched word. */
  highlights: number[][];
  /** The event the words were found in; null for a title hit. */
  seq: number | null;
  turn_id: number | null;
  room_id?: number | null;
};

export type SearchPage = {
  query: string;
  hits: SearchHit[];
  hasMore: boolean;
  /** Where the next page starts; null once there is no more. */
  nextOffset: number | null;
};

/** The server finds nothing for less, so the phone does not ask. */
export const MIN_SEARCH_CHARS = 2;
export const SEARCH_PAGE_SIZE = 20;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the server's answer tolerantly: unknown fields are ignored, and an older server with no paging fields has one page. */
export function readSearchPage(raw: unknown, query: string): SearchPage {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { hits?: unknown; has_more?: unknown; next_offset?: unknown };
  const hits = Array.isArray(body.hits) ? (body.hits.filter((hit) => hit && typeof hit === 'object' && isNumber((hit as SearchHit).thread_id)) as SearchHit[]) : [];
  const nextOffset = isNumber(body.next_offset) ? body.next_offset : null;
  return { query, hits, hasMore: body.has_more === true && nextOffset !== null, nextOffset };
}

export type Piece = { text: string; match: boolean };

/** The snippet cut into plain and matched pieces. Ranges that are out of bounds are skipped; overlapping ones are merged. */
export function highlightPieces(snippet: string, highlights: number[][]): Piece[] {
  const ranges = highlights
    .filter((range) => range.length === 2 && isNumber(range[0]) && isNumber(range[1]) && range[1] > 0 && range[0] >= 0 && range[0] < snippet.length)
    .map(([start, length]) => [start, Math.min(snippet.length, start + length)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  const pieces: Piece[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) pieces.push({ text: snippet.slice(at, start), match: false });
    pieces.push({ text: snippet.slice(start, end), match: true });
    at = end;
  }
  if (at < snippet.length) pieces.push({ text: snippet.slice(at), match: false });
  return pieces;
}

/** Who wrote it, or that the title matched. */
export function hitLabel(hit: SearchHit): string {
  if (hit.kind === 'title') return 'Title';
  return hit.kind === 'user' ? 'You' : 'Agent';
}

export type HitTarget =
  | { pathname: '/rooms/[id]'; params: { id: string } }
  | { pathname: '/thread/[id]'; params: { id: string; seq?: string } };

/** Where a result opens: a room's own page, or the conversation at the message that matched. */
export function hitTarget(hit: SearchHit): HitTarget {
  if (typeof hit.room_id === 'number') return { pathname: '/rooms/[id]', params: { id: String(hit.room_id) } };
  return hit.seq === null || !isNumber(hit.seq)
    ? { pathname: '/thread/[id]', params: { id: String(hit.thread_id) } }
    : { pathname: '/thread/[id]', params: { id: String(hit.thread_id), seq: String(hit.seq) } };
}

/** The row key `transcript.ts` gives the event with this sequence number. */
export function rowKeyForSeq(seq: string | undefined): string | null {
  return seq !== undefined && /^\d{1,15}$/.test(seq) ? `e${Number(seq)}` : null;
}
