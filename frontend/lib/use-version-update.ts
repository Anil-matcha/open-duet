"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type VersionInfo } from "./api.ts";

export type VersionUpdateState = {
  loading: boolean;
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateCommand: string | null;
  releaseNotesUrl: string | null;
  dismissed: boolean;
  error: string | null;
};

let cachedVersionInfo: VersionInfo | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function isUpdateDismissed(version: string | null | undefined): boolean {
  if (typeof window === "undefined" || !version) return false;
  try {
    return window.localStorage.getItem(`open-duet:dismissed-update:${version}`) === "1";
  } catch {
    return false;
  }
}

export function dismissUpdate(version: string | null | undefined): void {
  if (typeof window === "undefined" || !version) return;
  try {
    window.localStorage.setItem(`open-duet:dismissed-update:${version}`, "1");
    notify();
  } catch {}
}

export function setCachedVersionInfoForTest(info: VersionInfo | null): void {
  cachedVersionInfo = info;
  notify();
}

export function useVersionUpdate(): VersionUpdateState & {
  dismiss: () => void;
  refresh: () => Promise<void>;
} {
  const [info, setInfo] = useState<VersionInfo | null>(() => cachedVersionInfo);
  const [loading, setLoading] = useState<boolean>(() => cachedVersionInfo === null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const fetchVersion = useCallback(async (refresh = false) => {
    try {
      setLoading(true);
      const data = await api.getVersionInfo(refresh);
      cachedVersionInfo = data;
      setInfo(data);
      setError(null);
      notify();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (!cachedVersionInfo) {
        void fetchVersion(false);
      }
    }, 0);

    const listener = () => {
      if (alive) {
        setInfo(cachedVersionInfo);
        setTick((n) => n + 1);
      }
    };
    listeners.add(listener);

    // Also sync with Electron desktop updater if present
    const bridge = (window as unknown as {
      openDots?: { updates?: { onState: (cb: (state: unknown) => void) => () => void } };
    })?.openDots?.updates;
    let stopBridge: (() => void) | undefined;
    if (bridge?.onState) {
      stopBridge = bridge.onState((desktopState: unknown) => {
        const state = desktopState as { status?: string; version?: string } | null;
        if (state?.status === "available" && state?.version) {
          if (cachedVersionInfo) {
            cachedVersionInfo = {
              ...cachedVersionInfo,
              update_available: true,
              latest_version: state.version,
            };
            setInfo(cachedVersionInfo);
            notify();
          }
        } else if (state?.status === "idle") {
          if (cachedVersionInfo) {
            cachedVersionInfo = {
              ...cachedVersionInfo,
              update_available: false,
            };
            setInfo(cachedVersionInfo);
            notify();
          }
        }
      });
    }

    return () => {
      clearTimeout(timer);
      alive = false;
      listeners.delete(listener);
      stopBridge?.();
    };
  }, [fetchVersion]);

  const dismissed = Boolean(info?.latest_version && isUpdateDismissed(info.latest_version));

  const dismiss = useCallback(() => {
    if (info?.latest_version) {
      dismissUpdate(info.latest_version);
    }
  }, [info]);

  const refresh = useCallback(() => fetchVersion(true), [fetchVersion]);

  const isAvailable = Boolean(
    info?.update_available &&
    info?.latest_version &&
    info?.current_version &&
    info.latest_version !== info.current_version
  );

  return {
    loading,
    updateAvailable: isAvailable,
    currentVersion: info?.current_version ?? null,
    latestVersion: info?.latest_version ?? null,
    updateCommand: info?.update_command ?? null,
    releaseNotesUrl: info?.release_notes_url ?? null,
    dismissed,
    error,
    dismiss,
    refresh,
  };
}