import { createApi } from '@/lib/api';
import { highlightPieces, hitLabel, hitTarget, readSearchPage, rowKeyForSeq, type SearchHit } from '@/lib/search';

const hit = (extra: Partial<SearchHit> = {}): SearchHit => ({
  thread_id: 7,
  thread_title: 'Trip',
  agent_id: null,
  archived: false,
  kind: 'user',
  at: '2026-10-29T10:00:00Z',
  snippet: 'Book a hotel in Lisbon',
  highlights: [[16, 6]],
  seq: 4,
  turn_id: 2,
  ...extra,
});

describe('readSearchPage', () => {
  it('reads the hits and where the next page starts', () => {
    expect(readSearchPage({ query: 'x', hits: [hit()], has_more: true, next_offset: 20, extra: 1 }, 'x')).toEqual({ query: 'x', hits: [hit()], hasMore: true, nextOffset: 20 });
  });

  it('treats an older server without paging fields as one page', () => {
    expect(readSearchPage({ query: 'x', hits: [hit()] }, 'x')).toMatchObject({ hasMore: false, nextOffset: null });
  });

  it('claims no more pages without a place to continue from, and drops rows without a conversation', () => {
    const page = readSearchPage({ hits: [hit(), { snippet: 'no id' }, null], has_more: true }, 'x');
    expect(page.hits).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('survives an answer that is not an object', () => {
    expect(readSearchPage(null, 'x')).toEqual({ query: 'x', hits: [], hasMore: false, nextOffset: null });
    expect(readSearchPage({ hits: 'nope' }, 'x').hits).toEqual([]);
  });
});

describe('highlightPieces', () => {
  it('cuts the snippet at the matches', () => {
    expect(highlightPieces('Book a hotel in Lisbon', [[16, 6]])).toEqual([
      { text: 'Book a hotel in ', match: false },
      { text: 'Lisbon', match: true },
    ]);
    expect(
      highlightPieces('red apples', [[0, 3], [4, 6]]).map((piece) => [piece.text, piece.match]),
    ).toEqual([['red', true], [' ', false], ['apples', true]]);
  });

  it('merges overlapping ranges and skips ones that do not fit', () => {
    expect(highlightPieces('abcdef', [[0, 3], [2, 3]])).toEqual([{ text: 'abcde', match: true }, { text: 'f', match: false }]);
    expect(highlightPieces('abc', [[9, 2], [-1, 2], [1, 0], [0]])).toEqual([{ text: 'abc', match: false }]);
    expect(highlightPieces('abc', [[1, 50]])).toEqual([{ text: 'a', match: false }, { text: 'bc', match: true }]);
  });

  it('keeps text with no matches, and an empty snippet', () => {
    expect(highlightPieces('plain', [])).toEqual([{ text: 'plain', match: false }]);
    expect(highlightPieces('', [])).toEqual([]);
  });
});

describe('hits', () => {
  it('says who wrote the match', () => {
    expect(hitLabel(hit({ kind: 'title' }))).toBe('Title');
    expect(hitLabel(hit({ kind: 'user' }))).toBe('You');
    expect(hitLabel(hit({ kind: 'assistant' }))).toBe('Agent');
    expect(hitLabel(hit({ kind: 'room.message' }))).toBe('Agent');
  });

  it('opens a message hit at its message, a title hit at the conversation, and a room hit in the room', () => {
    expect(hitTarget(hit())).toEqual({ pathname: '/thread/[id]', params: { id: '7', seq: '4' } });
    expect(hitTarget(hit({ kind: 'title', seq: null }))).toEqual({ pathname: '/thread/[id]', params: { id: '7' } });
    expect(hitTarget(hit({ room_id: 3 }))).toEqual({ pathname: '/rooms/[id]', params: { id: '3' } });
  });

  it('turns a sequence number into the transcript row key, and nothing for anything else', () => {
    expect(rowKeyForSeq('12')).toBe('e12');
    expect(rowKeyForSeq('007')).toBe('e7');
    for (const bad of [undefined, '', 'abc', '1.5', '-1', '1e3', '1234567890123456']) expect(rowKeyForSeq(bad)).toBeNull();
  });
});

describe('searchConversations', () => {
  const session = { server: 'https://dots.example.com', token: 'ods_t' };
  const reply = (body: unknown) => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { api: createApi(session, { fetchImpl: impl }), calls };
  };

  it('asks for one page of an encoded query and returns it decoded', async () => {
    const { api, calls } = reply({ query: 'a b&c', hits: [hit()], has_more: true, next_offset: 40 });
    const page = await api.searchConversations('a b&c', 20, 20);
    expect(calls).toEqual(['https://dots.example.com/api/v1/search?q=a%20b%26c&limit=20&offset=20']);
    expect(page).toMatchObject({ hasMore: true, nextOffset: 40 });
    expect(page.hits).toHaveLength(1);
  });

  it('starts at the first page with the usual page size', async () => {
    const { api, calls } = reply({ hits: [] });
    await api.searchConversations('lisbon');
    expect(calls[0]).toBe('https://dots.example.com/api/v1/search?q=lisbon&limit=20&offset=0');
  });
});
