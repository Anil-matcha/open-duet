// Small, pure rules for the message box, kept out of the component so they can be tested.

export const LONG_PASTE_CHARS = 800;

// Enter sends; Shift+Enter adds a line. Enter that confirms an IME candidate (isComposing,
// or the legacy keyCode 229 some browsers report instead) must never send.
export function isSendKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS;
}

// Pasted segments that are still in the box (the person may have edited them away).
export function livePastes(value: string, pastes: string[]): string[] {
  return pastes.filter((p) => value.includes(p));
}

// Removes one pasted segment from the text, leaving the rest as typed.
export function removePaste(value: string, paste: string): string {
  return value.replace(paste, "");
}
