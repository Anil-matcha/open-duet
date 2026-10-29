import { act, fireEvent, render, screen } from '@testing-library/react-native';

import Search from '../app/search';
import { ApiError } from '@/lib/api';
import type { SearchHit, SearchPage } from '@/lib/search';

const mockPush = jest.fn();
const mockApi = { searchConversations: jest.fn() };

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/lib/use-api', () => ({ useApi: () => mockApi }));

const hit = (threadId: number, extra: Partial<SearchHit> = {}): SearchHit => ({
  thread_id: threadId,
  thread_title: `Trip ${threadId}`,
  agent_id: null,
  archived: false,
  kind: 'user',
  at: new Date().toISOString(),
  snippet: 'Book a hotel in Lisbon',
  highlights: [[16, 6]],
  seq: threadId,
  turn_id: 1,
  ...extra,
});
const page = (hits: SearchHit[], nextOffset: number | null = null): SearchPage => ({ query: 'lisbon', hits, hasMore: nextOffset !== null, nextOffset });

const OFFLINE = 'Could not reach your server. Check your connection.';

async function pause() {
  // Past the pause before a search is sent.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(400);
  });
}

async function typeQuery(text: string) {
  await fireEvent.changeText(screen.getByLabelText('Search conversations'), text);
  await pause();
}

async function reachEnd() {
  await act(async () => {
    fireEvent(screen.getByTestId('search-results'), 'endReached');
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

describe('Search', () => {
  it('waits for enough letters, then shows the matches marked', async () => {
    mockApi.searchConversations.mockResolvedValue(page([hit(7)]));
    await render(<Search />);
    expect(screen.getByText(/Type at least 2 letters/)).toBeTruthy();

    await typeQuery('l');
    expect(mockApi.searchConversations).not.toHaveBeenCalled();

    await typeQuery('lisbon');
    expect(mockApi.searchConversations).toHaveBeenCalledTimes(1);
    expect(mockApi.searchConversations).toHaveBeenCalledWith('lisbon');
    expect(screen.getByText('Trip 7')).toBeTruthy();
    expect(screen.getByText(/You · /)).toBeTruthy();
    // The matched word is its own piece of text.
    expect(screen.getByText('Lisbon')).toBeTruthy();
  });

  it('sends one search for a burst of typing', async () => {
    mockApi.searchConversations.mockResolvedValue(page([]));
    await render(<Search />);
    const input = screen.getByLabelText('Search conversations');
    await fireEvent.changeText(input, 'li');
    await fireEvent.changeText(input, 'lis');
    await fireEvent.changeText(input, 'lisb');
    await pause();
    expect(mockApi.searchConversations).toHaveBeenCalledTimes(1);
    expect(mockApi.searchConversations).toHaveBeenCalledWith('lisb');
  });

  it('opens a result at its message, and a room result in the room', async () => {
    mockApi.searchConversations.mockResolvedValue(
      page([hit(7, { seq: 4 }), hit(8, { kind: 'title', seq: null, thread_title: 'Only title' }), hit(9, { room_id: 3, thread_title: 'Team room' })]),
    );
    await render(<Search />);
    await typeQuery('lisbon');

    await fireEvent.press(screen.getByText('Trip 7'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/thread/[id]', params: { id: '7', seq: '4' } });
    await fireEvent.press(screen.getByText('Only title'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/thread/[id]', params: { id: '8' } });
    await fireEvent.press(screen.getByText('Team room'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/rooms/[id]', params: { id: '3' } });
  });

  it('loads the next page at the end of the list and stops when there is no more', async () => {
    mockApi.searchConversations.mockResolvedValueOnce(page([hit(1)], 1)).mockResolvedValueOnce(page([hit(2)], null));
    await render(<Search />);
    await typeQuery('lisbon');
    expect(screen.queryByText('Trip 2')).toBeNull();

    await reachEnd();
    expect(mockApi.searchConversations).toHaveBeenLastCalledWith('lisbon', 1);
    expect(screen.getByText('Trip 1')).toBeTruthy();
    expect(screen.getByText('Trip 2')).toBeTruthy();

    await reachEnd();
    expect(mockApi.searchConversations).toHaveBeenCalledTimes(2);
  });

  it('asks for a page once while it is on its way', async () => {
    let resolve!: (value: SearchPage) => void;
    mockApi.searchConversations.mockResolvedValueOnce(page([hit(1)], 1)).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await render(<Search />);
    await typeQuery('lisbon');
    await reachEnd();
    await reachEnd();
    await reachEnd();
    expect(mockApi.searchConversations).toHaveBeenCalledTimes(2);
    await act(async () => resolve(page([hit(2)])));
    expect(screen.getByText('Trip 2')).toBeTruthy();
  });

  it('keeps the results when a further page fails, and tries the same page again', async () => {
    mockApi.searchConversations
      .mockResolvedValueOnce(page([hit(1)], 1))
      .mockRejectedValueOnce(new ApiError(0, 'unreachable', ''))
      .mockResolvedValueOnce(page([hit(2)], null));
    await render(<Search />);
    await typeQuery('lisbon');
    await reachEnd();
    expect(screen.getByText('Trip 1')).toBeTruthy();
    expect(screen.getByText(OFFLINE)).toBeTruthy();

    await reachEnd();
    expect(mockApi.searchConversations).toHaveBeenLastCalledWith('lisbon', 1);
    expect(screen.getByText('Trip 2')).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it('says when nothing matches', async () => {
    mockApi.searchConversations.mockResolvedValue(page([]));
    await render(<Search />);
    await typeQuery('zzz');
    expect(screen.getByText('No conversations match “zzz”.')).toBeTruthy();
  });

  it('shows why the search failed and tries again', async () => {
    mockApi.searchConversations.mockRejectedValueOnce(new ApiError(0, 'unreachable', '')).mockResolvedValueOnce(page([hit(7)]));
    await render(<Search />);
    await typeQuery('lisbon');
    expect(screen.getByText(OFFLINE)).toBeTruthy();

    await fireEvent.press(screen.getByText('Try again'));
    await pause();
    expect(screen.getByText('Trip 7')).toBeTruthy();
  });

  it('ignores a late answer to an earlier query', async () => {
    let resolveOld!: (value: SearchPage) => void;
    mockApi.searchConversations
      .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce(page([hit(2, { thread_title: 'Newer answer' })]));
    await render(<Search />);
    await typeQuery('lisbon');
    await typeQuery('lisbons');
    expect(screen.getByText('Newer answer')).toBeTruthy();

    await act(async () => resolveOld(page([hit(1, { thread_title: 'Stale answer' })])));
    expect(screen.queryByText('Stale answer')).toBeNull();
    expect(screen.getByText('Newer answer')).toBeTruthy();
  });
});
