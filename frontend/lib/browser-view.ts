// What the live browser view sends to the server: pointer and key events as small JSON messages, with the
// pointer mapped from the canvas on screen to the page's own pixels (the frame size the server reports).

export type FrameSize = { w: number; h: number };
export type Rect = { left: number; top: number; width: number; height: number };
export type KeyEventLike = { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean };

export const NAMED_KEYS = ["Enter", "Backspace", "Tab", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];

export function framePoint(rect: Rect, size: FrameSize, clientX: number, clientY: number): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || size.w <= 0 || size.h <= 0) return null;
  const x = ((clientX - rect.left) * size.w) / rect.width;
  const y = ((clientY - rect.top) * size.h) / rect.height;
  if (x < 0 || y < 0 || x > size.w || y > size.h) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

export function buttonName(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

export function mouseMessage(action: "move" | "down" | "up", point: { x: number; y: number }, button = 0) {
  return { t: "mouse", a: action, x: point.x, y: point.y, b: buttonName(button) };
}

export function wheelMessage(point: { x: number; y: number }, dx: number, dy: number) {
  return { t: "wheel", x: point.x, y: point.y, dx: Math.round(dx), dy: Math.round(dy) };
}

// Modifier bits as the server expects: Alt 1, Ctrl 2, Meta 4, Shift 8.
export function modifiers(event: KeyEventLike): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

// A key the page understands, or null for keys the view does not relay (function keys, dead keys, IME).
export function keyMessage(event: KeyEventLike, action: "down" | "up") {
  const named = NAMED_KEYS.includes(event.key);
  const printable = [...event.key].length === 1;
  if (!named && !printable) return null;
  return { t: "key", a: action, key: event.key, mods: modifiers(event) };
}

export function textMessage(text: string) {
  return text ? { t: "text", text: text.slice(0, 2000) } : null;
}

export function navMessage(address: string) {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { t: "nav", url };
}

// The first message of a frame stream names its size; every binary message is one JPEG frame.
export function parseServerText(raw: string): { kind: "size"; size: FrameSize } | { kind: "refused"; text: string } | null {
  try {
    const message = JSON.parse(raw);
    if (message?.t === "size" && Number.isFinite(message.w) && Number.isFinite(message.h) && message.w > 0 && message.h > 0) return { kind: "size", size: { w: message.w, h: message.h } };
    if (message?.t === "refused" && typeof message.text === "string") return { kind: "refused", text: message.text };
  } catch {
    // not a message the view understands
  }
  return null;
}

// The view has two modes. Watching streams the page and relays nothing, so the agent keeps working; driving holds
// control (the agent's browser calls are refused) and relays pointer, keys, text and addresses.
export type ViewState = "starting" | "waiting" | "watching" | "taking" | "driving" | "lost";
export type ViewEvent = "frame" | "notrunning" | "drop" | "take" | "failed" | "release";

export function viewState(state: ViewState, event: ViewEvent): ViewState {
  if (event === "release") return "starting"; // handing control back goes straight back to watching
  if (event === "frame") return state === "starting" || state === "waiting" ? "watching" : state === "taking" ? "driving" : state;
  if (event === "notrunning") return state === "driving" || state === "taking" || state === "lost" ? state : "waiting";
  if (event === "drop") return state === "driving" || state === "lost" ? "lost" : "starting";
  if (event === "take") return state === "watching" ? "taking" : state === "lost" ? "taking" : state;
  if (event === "failed") return state === "taking" ? "watching" : state;
  return state;
}

// Watching reconnects by itself: quickly at first, then slower, never louder. A browser that is not running is
// checked every few seconds without any message beyond the plain "not running" line.
export function retryDelayMs(attempt: number, notRunning = false): number {
  if (notRunning) return 5000;
  return Math.min(15000, 1000 * 2 ** Math.max(0, Math.min(attempt, 4)));
}

export function viewNote(state: ViewState): string {
  switch (state) {
    case "waiting": return "The agent's browser is not running right now. It opens when the agent next uses it.";
    case "starting": return "Connecting to the agent's browser…";
    case "watching": return "Watching the agent's browser. The agent keeps working.";
    case "taking": return "Taking control…";
    case "driving": return "You are in control of the browser. The agent's browser calls wait until you hand control back.";
    case "lost": return "Connection lost. Reconnect within 20 seconds to keep control.";
  }
}

// What the person may do in each state: only a held session relays input.
export function canDrive(state: ViewState): boolean {
  return state === "driving";
}
