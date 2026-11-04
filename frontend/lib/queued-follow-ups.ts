export type QueuedFollowUp = { id: string; text: string };

const PREFIX = "open-duet:queued-follow-ups:";
export const MAX_QUEUED_FOLLOW_UPS = 20;
export const MAX_FOLLOW_UP_TEXT_CHARS = 100_000;
export const EMPTY_QUEUED_FOLLOW_UPS: QueuedFollowUp[] = [];

const snapshots = new Map<number, { raw: string | null; items: QueuedFollowUp[] }>();
const memoryFallback = new Map<number, QueuedFollowUp[]>();
const subscribers = new Map<number, Set<() => void>>();

function readRaw(threadId: number): { available: boolean; raw: string | null } {
  try {
    return { available: true, raw: localStorage.getItem(PREFIX + threadId) };
  } catch {
    return { available: false, raw: null };
  }
}

function parseItems(raw: string | null): QueuedFollowUp[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return EMPTY_QUEUED_FOLLOW_UPS;
    return parsed
      .filter((item): item is QueuedFollowUp =>
        !!item && typeof item === "object" && typeof item.id === "string" &&
        typeof item.text === "string" && item.text.trim() !== ""
      )
      .slice(0, MAX_QUEUED_FOLLOW_UPS)
      .filter((item) => item.text.length <= MAX_FOLLOW_UP_TEXT_CHARS)
      .map((item) => ({ id: item.id, text: item.text }));
  } catch {
    return EMPTY_QUEUED_FOLLOW_UPS;
  }
}

function notify(threadId: number): void {
  for (const subscriber of subscribers.get(threadId) ?? []) subscriber();
}

export function loadQueuedFollowUps(threadId: number): QueuedFollowUp[] {
  const storage = readRaw(threadId);
  if (!storage.available) return memoryFallback.get(threadId) ?? EMPTY_QUEUED_FOLLOW_UPS;
  const cached = snapshots.get(threadId);
  if (cached?.raw === storage.raw) return cached.items;
  const items = parseItems(storage.raw);
  snapshots.set(threadId, { raw: storage.raw, items });
  return items;
}

export function subscribeQueuedFollowUps(threadId: number, subscriber: () => void): () => void {
  const listeners = subscribers.get(threadId) ?? new Set<() => void>();
  listeners.add(subscriber);
  subscribers.set(threadId, listeners);
  const key = PREFIX + threadId;
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    snapshots.delete(threadId);
    memoryFallback.delete(threadId);
    subscriber();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(subscriber);
    if (listeners.size === 0) subscribers.delete(threadId);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function saveQueuedFollowUps(threadId: number, items: QueuedFollowUp[]): void {
  const savedItems = items.slice(0, MAX_QUEUED_FOLLOW_UPS);
  const raw = savedItems.length === 0 ? null : JSON.stringify(savedItems);
  let stored = false;
  try {
    if (raw === null) localStorage.removeItem(PREFIX + threadId);
    else localStorage.setItem(PREFIX + threadId, raw);
    stored = true;
  } catch {
    // The composer still works when browser storage is unavailable.
  }
  if (stored) {
    memoryFallback.delete(threadId);
    snapshots.set(threadId, { raw, items: savedItems });
  } else {
    memoryFallback.set(threadId, savedItems);
  }
  notify(threadId);
}

export function newQueuedFollowUp(text: string): QueuedFollowUp {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, text };
}
