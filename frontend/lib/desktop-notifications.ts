/**
 * Desktop and browser OS notification dispatcher (BL-83).
 *
 * Supports both Electron native notifications (via `window.openDots.showNotification`)
 * and web browser Notification API, respecting user category preferences and sound settings.
 */

import type { AppNotification, NotificationPreferences } from "./api";

// In-memory set of notification IDs that have already triggered an OS alert during this session.
const notifiedIds = new Set<number>();

type DesktopNotificationBridge = {
  showNotification?: (payload: { title: string; body?: string; tag?: string; silent?: boolean; thread_id?: number | null }) => Promise<boolean>;
  onNotificationClicked?: (listener: (data: { thread_id: number }) => void) => () => void;
};

function getDesktopBridge(): DesktopNotificationBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { openDots?: DesktopNotificationBridge }).openDots;
}

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && Boolean(getDesktopBridge()?.showNotification);
}

export function canRequestBrowserPermission(): boolean {
  return typeof window !== "undefined" && "Notification" in window && !isDesktopApp();
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (isDesktopApp()) return "granted";
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  return await Notification.requestPermission();
}

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}

export function isQuietHours(
  prefs: NotificationPreferences,
  now: Date = new Date(),
): boolean {
  if (!prefs.quiet_hours_enabled) return false;
  const start = prefs.quiet_hours_start || "22:00";
  const end = prefs.quiet_hours_end || "08:00";

  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = (Number.isFinite(startH) ? startH : 22) * 60 + (Number.isFinite(startM) ? startM : 0);
  const endMinutes = (Number.isFinite(endH) ? endH : 8) * 60 + (Number.isFinite(endM) ? endM : 0);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export function shouldNotify(
  item: AppNotification,
  prefs: NotificationPreferences,
  now: Date = new Date(),
): boolean {
  if (!prefs.desktop_enabled) return false;
  if (isQuietHours(prefs, now)) return false;

  const kind = item.kind.toLowerCase();
  if (
    kind === "needs_you" ||
    kind.includes("need") ||
    kind.includes("approval") ||
    kind.includes("question") ||
    kind.includes("decision") ||
    kind.includes("input")
  ) {
    return prefs.notify_needs_you;
  }
  if (
    kind.includes("fail") ||
    kind.includes("error") ||
    kind.includes("miss") ||
    kind.includes("interrupt") ||
    kind === "incident" ||
    kind === "escalation"
  ) {
    return prefs.notify_failures;
  }
  if (kind === "task_due" || kind.includes("due") || kind.includes("reminder") || kind.includes("deadline")) {
    return prefs.notify_task_due;
  }
  if (kind === "turn_completed" || kind.includes("complete") || kind.includes("finish")) {
    return prefs.notify_turn_completed ?? true;
  }
  return true;
}

export function getNewUnreadNotifications(
  items: readonly AppNotification[],
  seenIds: ReadonlySet<number> | null,
): AppNotification[] {
  if (!seenIds) return [];
  return items.filter((item) => !item.read_at && !seenIds.has(item.id));
}

export function showNotificationAlert({
  title,
  body,
  tag,
  onClick,
  silent = false,
  threadId = null,
}: {
  title: string;
  body?: string | null;
  tag?: string;
  onClick?: () => void;
  silent?: boolean;
  threadId?: number | null;
}): boolean {
  if (typeof window === "undefined") return false;

  const cleanBody = body ?? "";
  const bridge = getDesktopBridge();

  // 1. Desktop app (Electron bridge)
  if (bridge?.showNotification) {
    void bridge.showNotification({ title, body: cleanBody, tag, silent, thread_id: threadId });
    return true;
  }

  // 2. Web browser Notification API
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const notif = new Notification(title, {
        body: cleanBody,
        tag,
        icon: "/favicon.ico",
        silent,
      });
      if (onClick) {
        notif.onclick = () => {
          window.focus();
          onClick();
          notif.close();
        };
      }
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function dispatchNotification(
  item: AppNotification,
  prefs: NotificationPreferences,
  onOpenThread?: (threadId: number) => void,
): boolean {
  if (item.read_at || notifiedIds.has(item.id)) return false;
  if (!shouldNotify(item, prefs)) return false;

  notifiedIds.add(item.id);

  if (prefs.sound_enabled) {
    playNotificationSound();
  }

  return showNotificationAlert({
    title: item.title,
    body: item.body,
    tag: `notification-${item.id}`,
    onClick: item.thread_id !== null && onOpenThread ? () => onOpenThread(item.thread_id!) : undefined,
    silent: !prefs.sound_enabled,
    threadId: item.thread_id,
  });
}


export function isAppBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus());
}

export function cleanPreviewText(text: string | null | undefined, limit = 140): string {
  if (!text) return "";
  const stripped = text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1).trimEnd() + "…";
}

export function notifyTurnCompletion({
  agentName,
  text,
  status,
  error,
  threadId,
  prefs,
  onOpenThread,
}: {
  agentName?: string | null;
  text?: string | null;
  status: "completed" | "failed" | string;
  error?: string | null;
  threadId?: number | null;
  prefs: NotificationPreferences;
  onOpenThread?: (threadId: number) => void;
}): boolean {
  if (!prefs.desktop_enabled) return false;
  if (isQuietHours(prefs)) return false;
  if (!isAppBackgrounded()) return false;

  const displayName = agentName?.trim() || "Open Duet";

  if (status === "completed") {
    if (prefs.notify_turn_completed === false) return false;
    const preview = cleanPreviewText(text) || "Response ready.";
    if (prefs.sound_enabled) playNotificationSound();
    return showNotificationAlert({
      title: displayName,
      body: preview,
      tag: `turn-completed-${threadId ?? "global"}-${Date.now()}`,
      threadId,
      onClick: threadId != null && onOpenThread ? () => onOpenThread(threadId) : undefined,
      silent: !prefs.sound_enabled,
    });
  }

  if (status === "failed") {
    if (prefs.notify_failures === false) return false;
    const preview = cleanPreviewText(error) || "The request could not be completed.";
    if (prefs.sound_enabled) playNotificationSound();
    return showNotificationAlert({
      title: `${displayName} (Failed)`,
      body: preview,
      tag: `turn-failed-${threadId ?? "global"}-${Date.now()}`,
      threadId,
      onClick: threadId != null && onOpenThread ? () => onOpenThread(threadId) : undefined,
      silent: !prefs.sound_enabled,
    });
  }

  return false;
}

export function notifyApprovalNeeded({
  agentName,
  summary,
  tool,
  threadId,
  approvalId,
  prefs,
  onOpenThread,
}: {
  agentName?: string | null;
  summary?: string | null;
  tool?: string | null;
  threadId?: number | null;
  approvalId: string;
  prefs: NotificationPreferences;
  onOpenThread?: (threadId: number) => void;
}): boolean {
  if (!prefs.desktop_enabled || !prefs.notify_needs_you) return false;
  if (isQuietHours(prefs)) return false;
  if (!isAppBackgrounded()) return false;

  const displayName = agentName?.trim() || "Open Duet";
  const preview = cleanPreviewText(summary || tool) || "An action requires your approval.";
  if (prefs.sound_enabled) playNotificationSound();
  return showNotificationAlert({
    title: `${displayName} needs approval`,
    body: preview,
    tag: `approval-${approvalId}`,
    threadId,
    onClick: threadId != null && onOpenThread ? () => onOpenThread(threadId) : undefined,
    silent: !prefs.sound_enabled,
  });
}
