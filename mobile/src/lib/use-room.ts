import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { describeApiError, type ThreadEvent } from './api';
import { useAuth } from './auth-context';
import { applyRoomEvents, emptyFeed, loadRoomApprovals, roomBusy, type Room, type RoomApproval } from './rooms';
import { followThread, type Connection } from './sse';
import { useApi } from './use-api';

// The room's roster, who is working and what is waiting for you can change without a message arriving
// (an agent asks for approval while it works), so they are read again on a timer as well as whenever
// something new arrives.
const REFRESH_MS = 5_000;
const EVENT_REFRESH_MS = 300;
const READ_MS = 800;

export function useRoom(roomId: number) {
  const api = useApi();
  const { state, revoked } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [feed, dispatch] = useReducer(applyRoomEvents, undefined, emptyFeed);
  const [approvals, setApprovals] = useState<RoomApproval[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(0);
  const lastSeq = useRef(0);
  useEffect(() => {
    lastSeq.current = feed.lastSeq;
  }, [feed.lastSeq]);

  const server = state.status === 'paired' ? state.server : null;
  const token = state.status === 'paired' ? state.token : null;
  const threadId = room?.thread_id ?? null;

  // `keepError` leaves a message about something the person just did on screen, for a refresh that follows it.
  const refresh = useCallback(
    async (keepError = false) => {
      if (!api) return;
      try {
        const next = await api.getRoom(roomId);
        setRoom(next);
        setApprovals(await loadRoomApprovals(api, next));
        if (!keepError) setError(null);
      } catch (err) {
        setError(describeApiError(err));
      }
    },
    [api, roomId],
  );

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  // Follow the room's own thread: its stored events are the messages.
  useEffect(() => {
    if (!server || !token || threadId === null) return;
    const controller = new AbortController();
    let queue: ThreadEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const events = queue;
      queue = [];
      if (events.length) {
        dispatch(events);
        void refresh();
      }
    };
    void followThread({
      session: { server, token },
      threadId,
      after: lastSeq.current,
      signal: controller.signal,
      onEvents: (events) => {
        queue.push(...events);
        if (!timer) timer = setTimeout(flush, EVENT_REFRESH_MS);
      },
      onConnection: setConnection,
      onRevoked: revoked,
    });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [server, token, threadId, restart, revoked, refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') setRestart((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);

  // Opening a room and reading new messages in it marks it read.
  useEffect(() => {
    if (!api || feed.lastSeq === 0) return;
    const timer = setTimeout(() => void api.markRoomRead(roomId, feed.lastSeq).catch(() => undefined), READ_MS);
    return () => clearTimeout(timer);
  }, [api, roomId, feed.lastSeq]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!api) return false;
      try {
        await api.postRoomMessage(roomId, text);
        setError(null);
        void refresh();
        return true;
      } catch (err) {
        setError(describeApiError(err));
        return false;
      }
    },
    [api, roomId, refresh],
  );

  const stop = useCallback(async () => {
    if (!api) return;
    try {
      await api.stopRoom(roomId);
      setError(null);
    } catch (err) {
      setError(describeApiError(err));
    }
    void refresh();
  }, [api, roomId, refresh]);

  const answer = useCallback(
    async (approval: RoomApproval, decision: 'allow' | 'deny'): Promise<boolean> => {
      if (!api) return false;
      try {
        await api.answerApproval(approval.threadId, approval.approvalId, decision);
        setError(null);
        void refresh();
        return true;
      } catch (err) {
        setError(describeApiError(err));
        // Someone else answered, or it ran out: what is still waiting may have changed.
        void refresh(true);
        return false;
      }
    },
    [api, refresh],
  );

  const loaded = room !== null && feed.lastSeq >= room.last_seq;

  return { room, items: feed.items, approvals, connection, error, loaded, busy: roomBusy(room), send, stop, answer };
}
