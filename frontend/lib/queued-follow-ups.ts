export type QueuedFollowUp = { id: string; text: string };

const PREFIX = "open-duet:queued-follow-ups:";
export const MAX_QUEUED_FOLLOW_UPS = 20;
export const MAX_FOLLOW_UP_TEXT_CHARS = 100_000;

export function loadQueuedFollowUps(threadId: number): QueuedFollowUp[] {
  try {
    const raw = localStorage.getItem(PREFIX + threadId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is QueuedFollowUp =>
        !!item && typeof item === "object" && typeof item.id === "string" &&
        typeof item.text === "string" && item.text.trim() !== ""
      )
      .slice(0, MAX_QUEUED_FOLLOW_UPS)
      .filter((item) => item.text.length <= MAX_FOLLOW_UP_TEXT_CHARS)
      .map((item) => ({ id: item.id, text: item.text }));
  } catch {
    return [];
  }
}

export function saveQueuedFollowUps(threadId: number, items: QueuedFollowUp[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(PREFIX + threadId);
    else localStorage.setItem(PREFIX + threadId, JSON.stringify(items.slice(0, MAX_QUEUED_FOLLOW_UPS)));
  } catch {
    // The composer still works when browser storage is unavailable.
  }
}

export function newQueuedFollowUp(text: string): QueuedFollowUp {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, text };
}
