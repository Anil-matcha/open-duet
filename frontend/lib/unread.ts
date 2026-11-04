// Which conversations have moved since the person last looked. The backend keeps no read
// state, so this is per browser: a last-seen time for each conversation, kept in localStorage.
// Limitation: it is not shared between devices, and a cleared browser starts everything as read.
// No runtime imports so node tests can load it.

export type SeenMap = Record<string, string>;
type ThreadLike = { id: number; updated_at: string; archived_at: string | null };

const KEY = "open-duet:thread-seen";

export function loadSeen(): SeenMap {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

export function saveSeen(seen: SeenMap): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Private window or blocked storage: unread simply resets on reload.
  }
}

// Moves the map forward for the threads now listed: one never seen before is taken as read (so
// nothing is unread on first run), the open one is read now, and ones that are gone are dropped.
// Returns the same object when nothing changed.
export function reconcileSeen(threads: readonly ThreadLike[], seen: SeenMap, selectedId: number | null): SeenMap {
  const next: SeenMap = {};
  let changed = false;
  for (const thread of threads) {
    const key = String(thread.id);
    const known = seen[key];
    const value = known === undefined || thread.id === selectedId ? thread.updated_at : known;
    next[key] = value;
    if (value !== known) changed = true;
  }
  if (Object.keys(seen).length !== Object.keys(next).length) changed = true;
  return changed ? next : seen;
}

export function isUnread(thread: ThreadLike, seen: SeenMap, selectedId: number | null): boolean {
  if (thread.archived_at !== null || thread.id === selectedId) return false;
  const last = seen[String(thread.id)];
  return last !== undefined && Date.parse(thread.updated_at) > Date.parse(last);
}
