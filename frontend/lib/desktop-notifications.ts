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
  showNotification?: (payload: { title: string; body?: string; tag?: string; silent?: boolean }) => Promise<boolean>;
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

export function shouldNotify(item: AppNotification, prefs: NotificationPreferences): boolean {
  if (!prefs.desktop_enabled) return false;

  const kind = item.kind.toLowerCase();
  if (kind === "needs_you" || kind.includes("approval") || kind.includes("question") || kind.includes("decision")) {
    return prefs.notify_needs_you;
  }
  if (kind.includes("fail") || kind.includes("error") || kind === "incident" || kind === "escalation") {
    return prefs.notify_failures;
  }
  if (kind === "task_due" || kind.includes("due") || kind.includes("reminder") || kind.includes("deadline")) {
    return prefs.notify_task_due;
  }
  return true;
}

export function showNotificationAlert({
  title,
  body,
  tag,
  onClick,
  silent = false,
}: {
  title: string;
  body?: string | null;
  tag?: string;
  onClick?: () => void;
  silent?: boolean;
}): boolean {
  if (typeof window === "undefined") return false;

  const cleanBody = body ?? "";
  const bridge = getDesktopBridge();

  // 1. Desktop app (Electron bridge)
  if (bridge?.showNotification) {
    void bridge.showNotification({ title, body: cleanBody, tag, silent });
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
  });
}