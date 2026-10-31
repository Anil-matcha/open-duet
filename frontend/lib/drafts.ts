// Unsent message text, kept per conversation so switching away and back loses nothing.
// Browser storage can be missing or throw (private windows), so every call is guarded and the
// box works the same without it.

const PREFIX = "open-duet:draft:";
const MAX_CHARS = 20000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(key: string | null, store: Store | null = defaultStore()): string {
  if (!key || !store) return "";
  try {
    return store.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

// Empty text clears the draft, so a sent message does not come back.
export function saveDraft(key: string | null, text: string, store: Store | null = defaultStore()): void {
  if (!key || !store) return;
  try {
    if (text.trim() === "") store.removeItem(PREFIX + key);
    else store.setItem(PREFIX + key, text.slice(0, MAX_CHARS));
  } catch {
    // storage full or blocked: the draft just is not kept
  }
}
