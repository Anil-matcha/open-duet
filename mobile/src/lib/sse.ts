// Follows one thread live: the server's event stream with a bearer token, reconnecting from the last
// event seen, and plain paging as a fallback when the platform cannot stream a response body.
//
// The server replays exactly what a client missed when it reconnects with `Last-Event-ID` (docs/SETUP.md),
// and a stored event is applied at most once (transcript.ts), so reconnecting is always safe.

import { createApi, type Session, type ThreadEvent } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'polling';

type FetchLike = typeof fetch;

/** Feed it decoded text in any chunking; it calls `onEvent` once per complete frame. */
export function createSseParser(onEvent: (event: ThreadEvent) => void) {
  let buffer = '';

  function frame(block: string) {
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank or keep-alive comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
    }
    if (data.length === 0) return;
    try {
      const parsed = JSON.parse(data.join('\n')) as Partial<ThreadEvent> | null;
      if (parsed && typeof parsed.type === 'string' && parsed.data && typeof parsed.data === 'object') {
        onEvent(parsed as ThreadEvent);
      }
    } catch {
      // a frame that is not valid JSON is skipped, not fatal
    }
  }

  return {
    push(chunk: string) {
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      // A trailing "\r" may be the first half of "\r\n": keep it for the next chunk.
      const heldBack = buffer.endsWith('\r') ? '\r' : '';
      if (heldBack) buffer = buffer.slice(0, -1);
      buffer = buffer.replace(/\r/g, '\n');
      const blocks = buffer.split('\n\n');
      buffer = (blocks.pop() ?? '') + heldBack;
      for (const block of blocks) frame(block);
    },
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

export type FollowOptions = {
  session: Session;
  threadId: number;
  /** The seq of the newest event already shown (0 for none). */
  after: number;
  signal: AbortSignal;
  onEvents: (events: ThreadEvent[]) => void;
  onConnection: (state: Connection) => void;
  onRevoked: () => void;
  fetchImpl?: FetchLike;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const POLL_MS = 2000;

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/** Runs until `signal` aborts or the server revokes the session. */
export async function followThread(options: FollowOptions): Promise<void> {
  const { session, threadId, signal, onEvents, onConnection } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const api = createApi(session, { onRevoked: options.onRevoked, fetchImpl });
  let after = options.after;
  let attempt = 0;
  let polling = false;

  const advance = (events: ThreadEvent[]) => {
    for (const event of events) if (typeof event.seq === 'number' && event.seq > after) after = event.seq;
    if (events.length) onEvents(events);
  };

  while (!signal.aborted) {
    onConnection(polling ? 'polling' : attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      if (polling) {
        const page = await api.listEvents(threadId, after);
        advance(page.events);
        after = Math.max(after, page.next_after);
        attempt = 0;
        if (!page.has_more) await sleep(POLL_MS, signal);
        continue;
      }

      const response = await fetchImpl(`${session.server}/api/v1/threads/${threadId}/events/stream`, {
        headers: {
          Authorization: `Bearer ${session.token}`,
          Accept: 'text/event-stream',
          ...(after > 0 ? { 'Last-Event-ID': String(after) } : {}),
        },
        signal,
      });
      if (response.status === 401) {
        options.onRevoked();
        return;
      }
      if (!response.ok) throw new Error(`stream refused: ${response.status}`);
      if (!response.body) {
        // This platform cannot read a response as it arrives: page through the events instead.
        polling = true;
        continue;
      }

      onConnection('live');
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let batch: ThreadEvent[] = [];
      const parser = createSseParser((event) => batch.push(event));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (batch.length) {
          const events = batch;
          batch = [];
          advance(events);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (polling && (error as { status?: number }).status === 401) return;
    }
    if (signal.aborted) return;
    onConnection('reconnecting');
    await sleep(backoff(attempt++), signal);
  }
}
