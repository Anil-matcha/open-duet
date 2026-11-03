"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { bindSettingsShortcut, type SettingsShortcutBridge } from "@/lib/settings-shortcut";

const SETTINGS_PATH = "/settings/";

function hasOpenDialog(): boolean {
  return document.querySelector(
    'dialog[open], [role="dialog"]:not([aria-hidden="true"]):not([data-state="closed"]), [aria-modal="true"]',
  ) !== null;
}

export function useSettingsShortcut(): void {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const desktopBridge = (window as Window & { openDots?: SettingsShortcutBridge }).openDots;
    return bindSettingsShortcut({
      eventTarget: document,
      pathname,
      platform: navigator.platform,
      navigate: () => router.push(SETTINGS_PATH),
      dialogOpen: hasOpenDialog,
      bridge: desktopBridge,
    });
  }, [pathname, router]);
}

// A client leaf mounted by the root layout keeps the hook active across every route.
export function SettingsShortcutMount() {
  useSettingsShortcut();
  return null;
}
