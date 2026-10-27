import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { describeApiError, type Thread, type ThreadEvent } from './api';
import { useAuth } from './auth-context';
import { followThread, type Connection } from './sse';
import { applyEvents, emptyTranscript } from './transcript';
import { useApi } from './use-api';

// Events are applied in small batches: opening a long conversation replays every stored event.
const FLUSH_MS = 40;

export function useThread(threadId: number) {
  const api = useApi();
  const { state, revoked } = useAuth();
  const [transcript, dispatch] = useReducer(applyEvents, undefined, emptyTranscript);
  const [thread, setThread] = useState<Thread | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const lastSeq = useRef(0);
  useEffect(() => {
    lastSeq.current = transcript.lastSeq;
  }, [transcript.lastSeq]);

  const server = state.status === 'paired' ? state.server : null;
  const token = state.status === 'paired' ? state.token : null;

  // The conversation's title and how many events it has, so the screen knows when it has caught up.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getThread(threadId)
      .then((detail) => {
        if (!cancelled) setThread(detail);
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, threadId]);

  // Follow the stream; start over when the app comes back to the foreground, since the OS may have
  // closed the connection while it was away.
  useEffect(() => {
    if (!server || !token) return;
    const controller = new AbortController();
    let queue: ThreadEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const events = queue;
      queue = [];
      if (events.length) dispatch(events);
    };
    void followThread({
      session: { server, token },
      threadId,
      after: lastSeq.current,
      signal: controller.signal,
      onEvents: (events) => {
        queue.push(...events);
        if (!timer) timer = setTimeout(flush, FLUSH_MS);
      },
      onConnection: setConnection,
      onRevoked: revoked,
    });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [server, token, threadId, restart, revoked]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') setRestart((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!api) return false;
      try {
        await api.sendTurn(threadId, text);
        setError(null);
        return true;
      } catch (err) {
        setError(describeApiError(err));
        return false;
      }
    },
    [api, threadId],
  );

  const stop = useCallback(async () => {
    if (!api) return;
    try {
      await api.stopTurn(threadId);
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
  }, [api, threadId]);

  const loaded = thread !== null && transcript.lastSeq >= thread.last_seq;

  return { transcript, thread, connection, error, loaded, running: transcript.runningTurnId !== null, send, stop };
}
