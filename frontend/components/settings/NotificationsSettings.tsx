"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsCard } from "./SettingsCard";
import { Switch } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Applies } from "./Applies";
import { SavedConfirmation, useSavedConfirmation } from "./SavedConfirmation";
import { api, type NotificationPreferences } from "@/lib/api";
import {
  canRequestBrowserPermission,
  isDesktopApp,
  playNotificationSound,
  requestNotificationPermission,
  showNotificationAlert,
} from "@/lib/desktop-notifications";

const defaultPrefs: NotificationPreferences = {
  desktop_enabled: true,
  notify_needs_you: true,
  notify_failures: true,
  notify_task_due: true,
  sound_enabled: false,
};

function getNotificationPermissionSnapshot(): NotificationPermission {
  if (typeof window !== "undefined" && "Notification" in window) {
    return Notification.permission;
  }
  return "default";
}

function subscribeToPermission(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focus", callback);
  return () => window.removeEventListener("focus", callback);
}

export function NotificationsSettings() {
  const [prefs, setPrefs] = useState<NotificationPreferences>(defaultPrefs);
  const browserPermission = useSyncExternalStore(
    subscribeToPermission,
    getNotificationPermissionSnapshot,
    () => "default" as NotificationPermission,
  );
  const [testSent, setTestSent] = useState(false);
  const confirmation = useSavedConfirmation();

  useEffect(() => {
    let alive = true;
    api.getNotificationPreferences().then((loaded) => {
      if (alive) setPrefs(loaded);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const saveOption = (key: keyof NotificationPreferences, value: boolean) => {
    const updated = { ...prefs, [key]: value };
    setPrefs(updated);
    confirmation.showSaved(key);
    void api.updateNotificationPreferences(updated).catch(() => {});
  };

  const handleRequestPermission = async () => {
    await requestNotificationPermission();
  };

  const handleTestNotification = () => {
    if (prefs.sound_enabled) {
      playNotificationSound();
    }
    const success = showNotificationAlert({
      title: "Open Duet Notification",
      body: "Desktop notifications are working! You will be alerted when agents need you or routines fail.",
      silent: !prefs.sound_enabled,
    });
    if (success) {
      setTestSent(true);
      setTimeout(() => setTestSent(false), 3000);
    }
  };

  const isDesktop = isDesktopApp();

  return (
    <div className="space-y-6" data-setting-root data-setting-container tabIndex={-1}>
      <div id="setting-notifications-desktop" data-setting-id="setting-notifications-desktop" data-setting-container tabIndex={-1}>
        <SettingsCard
          title="Desktop notifications"
          description="Receive native operating system alerts when agents need your input or background tasks encounter issues."
          action={
            <Button size="sm" variant="secondary" onClick={handleTestNotification}>
              {testSent ? "Test sent!" : "Send test alert"}
            </Button>
          }
        >
          <div className="space-y-3">
            <Switch
              label="Enable desktop notifications"
              description="Show OS notifications when Open Duet is running in the background."
              checked={prefs.desktop_enabled}
              onChange={(e) => saveOption("desktop_enabled", e.target.checked)}
            />

            {!isDesktop && canRequestBrowserPermission() && browserPermission !== "granted" && (
              <div className="flex items-center justify-between rounded-field border border-line bg-surface p-3 text-xs">
                <span className="text-muted">
                  Browser notification permission is currently <strong>{browserPermission}</strong>.
                </span>
                <Button size="sm" onClick={handleRequestPermission}>
                  Allow notifications
                </Button>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <Applies when="now" />
              <SavedConfirmation visible={confirmation.saved.has("desktop_enabled")} />
            </div>
          </div>
        </SettingsCard>
      </div>

      <div id="setting-notifications-categories" data-setting-id="setting-notifications-categories" data-setting-container tabIndex={-1}>
        <SettingsCard
          title="What notifies you"
          description="Choose which categories of agent events should trigger desktop alerts."
        >
          <div className="space-y-4">
            <Switch
              label="Agent input & approvals"
              description="Notify when an agent asks a question, requests tool approval, or needs human guidance."
              disabled={!prefs.desktop_enabled}
              checked={prefs.notify_needs_you}
              onChange={(e) => saveOption("notify_needs_you", e.target.checked)}
            />

            <Switch
              label="Failures & errors"
              description="Notify when a background routine or delegated task fails or encounters an unhandled error."
              disabled={!prefs.desktop_enabled}
              checked={prefs.notify_failures}
              onChange={(e) => saveOption("notify_failures", e.target.checked)}
            />

            <Switch
              label="Task deadlines & reminders"
              description="Notify when a scheduled task reaches its reminder deadline."
              disabled={!prefs.desktop_enabled}
              checked={prefs.notify_task_due}
              onChange={(e) => saveOption("notify_task_due", e.target.checked)}
            />

            <div className="flex items-center gap-3 pt-1">
              <Applies when="now" />
              <SavedConfirmation
                visible={
                  confirmation.saved.has("notify_needs_you") ||
                  confirmation.saved.has("notify_failures") ||
                  confirmation.saved.has("notify_task_due")
                }
              />
            </div>
          </div>
        </SettingsCard>
      </div>

      <div id="setting-notifications-sound" data-setting-id="setting-notifications-sound" data-setting-container tabIndex={-1}>
        <SettingsCard
          title="Alert sound"
          description="Control audio alerts accompanying desktop notifications."
        >
          <div className="space-y-3">
            <Switch
              label="Notification chime"
              description="Play a subtle chime sound when a desktop notification arrives."
              disabled={!prefs.desktop_enabled}
              checked={prefs.sound_enabled}
              onChange={(e) => saveOption("sound_enabled", e.target.checked)}
            />

            <div className="flex items-center gap-3 pt-1">
              <Applies when="now" />
              <SavedConfirmation visible={confirmation.saved.has("sound_enabled")} />
            </div>
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}