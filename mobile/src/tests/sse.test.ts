import type { ThreadEvent } from '@/lib/api';
import { createSseParser, followThread, type Connection } from '@/lib/sse';

const frame = (seq: number, type: string, data: Record<string, unknown> = {}) =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ thread_id: 1, seq, type, turn_id: 1, data, ts: 'x' })}\n\n`;

function parse(...chunks: string[]): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe('createSseParser', () => {
  it('reads one event per frame', () => {
    expect(parse(frame(1, 'turn.started'), frame(2, 'assistant.message', { text: 'hi' })).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('copes with any chunking, including a frame cut in half', () => {
    const whole = frame(1, 'assistant.message', { text: 'héllo' }) + frame(2, 'turn.completed');
    for (let cut = 1; cut < whole.length; cut += 7) {
      expect(parse(whole.slice(0, cut), whole.slice(cut)).map((e) => e.seq)).toEqual([1, 2]);
    }
  });

  it('handles CRLF line ends, even split across chunks', () => {
    const crlf = frame(1, 'turn.started').replace(/\n/g, '\r\n');
    expect(parse(crlf.slice(0, -1), crlf.slice(-1)).map((e) => e.seq)).toEqual([1]);
  });

  it('ignores keep-alive comments, bad JSON and frames without a type', () => {
    expect(parse(': keepalive\n\n', 'data: {not json\n\n', 'data: {"data":{}}\n\n', frame(3, 'turn.started')).map((e) => e.seq)).toEqual([3]);
  });

  it('delivers typing frames, which have no seq', () => {
    const events = parse('event: text.delta\ndata: {"type":"text.delta","data":{"text":"He","mode":"append"}}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBeUndefined();
  });
});

// A fake streaming response: each entry in `chunks` arrives as one read.
function streamResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined }),
      }),
    },
  } as unknown as Response;
}

const session = { server: 'https://dots.example.com', token: 'ods_t' };

function run(replies: (Response | Error)[], extra: { after?: number } = {}) {
  const controller = new AbortController();
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const seen: ThreadEvent[] = [];
  const states: Connection[] = [];
  let revoked = 0;
  let call = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(init.headers as Record<string, string>);
    const reply = replies[Math.min(call++, replies.length - 1)];
    if (call >= replies.length) setTimeout(() => controller.abort(), 0);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch;
  const done = followThread({
    session,
    threadId: 1,
    after: extra.after ?? 0,
    signal: controller.signal,
    onEvents: (events) => seen.push(...events),
    onConnection: (state) => states.push(state),
    onRevoked: () => {
      revoked++;
    },
    fetchImpl,
    // Yield to the timer that aborts the run; a sleep that resolved at once would never let it fire.
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  return { done, urls, headers, seen, states, revoked: () => revoked, controller };
}

describe('followThread', () => {
  it('opens the stream with the bearer token and reports live', async () => {
    const t = run([streamResponse([frame(1, 'turn.started'), frame(2, 'assistant.message', { text: 'hi' })])]);
    await t.done;
    expect(t.urls[0]).toBe('https://dots.example.com/api/v1/threads/1/events/stream');
    expect(t.headers[0].Authorization).toBe('Bearer ods_t');
    expect(t.headers[0].Accept).toBe('text/event-stream');
    expect(t.headers[0]['Last-Event-ID']).toBeUndefined();
    expect(t.seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(t.states).toContain('live');
  });

  it('resumes from the last event seen when the connection drops', async () => {
    const t = run([streamResponse([frame(1, 'turn.started'), frame(2, 'assistant.message', { text: 'a' })]), streamResponse([frame(3, 'turn.completed')])]);
    await t.done;
    expect(t.headers[1]['Last-Event-ID']).toBe('2');
    expect(t.seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(t.states).toContain('reconnecting');
  });

  it('resumes after a network error too', async () => {
    const t = run([new TypeError('Network request failed'), streamResponse([frame(5, 'turn.started')])], { after: 4 });
    await t.done;
    expect(t.headers[0]['Last-Event-ID']).toBe('4');
    expect(t.headers[1]['Last-Event-ID']).toBe('4');
    expect(t.seen.map((e) => e.seq)).toEqual([5]);
  });

  it('stops and reports a revoked session on 401', async () => {
    const t = run([{ status: 401, ok: false, body: null } as unknown as Response]);
    await t.done;
    expect(t.revoked()).toBe(1);
    expect(t.urls).toHaveLength(1);
  });

  it('keeps trying after another error status', async () => {
    const t = run([{ status: 503, ok: false, body: null } as unknown as Response, streamResponse([frame(1, 'turn.started')])]);
    await t.done;
    expect(t.seen.map((e) => e.seq)).toEqual([1]);
  });

  it('pages through the events instead when the response cannot be streamed', async () => {
    const page = (events: unknown[], next: number) => ({
      status: 200,
      ok: true,
      body: null,
      json: async () => ({ events, next_after: next, has_more: false }),
    });
    const streamUnsupported = { status: 200, ok: true, body: null } as unknown as Response;
    const t = run([streamUnsupported, page([{ seq: 1, type: 'turn.started', data: {} }], 1) as unknown as Response, page([{ seq: 2, type: 'turn.completed', data: {} }], 2) as unknown as Response]);
    await t.done;
    expect(t.urls[1]).toBe('https://dots.example.com/api/v1/threads/1/events?after=0&limit=500');
    expect(t.urls[2]).toBe('https://dots.example.com/api/v1/threads/1/events?after=1&limit=500');
    expect(t.seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(t.states).toContain('polling');
  });

  it('stops when told to, without another request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = jest.fn();
    await followThread({
      session,
      threadId: 1,
      after: 0,
      signal: controller.signal,
      onEvents: () => undefined,
      onConnection: () => undefined,
      onRevoked: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
