"use client";

import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/use-i18n";

type Permissions = { supported: boolean; accessibility: boolean; screen_recording: boolean };

export function DesktopPermissions() {
  const t = useT();
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => void window.openDots?.desktopPermissions?.("status").then(value => { if (live) { setPermissions(value); setError(null); } }).catch(() => { if (live) setError(t("appSettings.permissions.error.check")); });
    refresh();
    window.addEventListener("focus", refresh);
    return () => { live = false; window.removeEventListener("focus", refresh); };
  }, [t]);
  async function check(action: "status" | "accessibility" | "screen_recording") {
    setBusy(true); setError(null);
    try {
      const value = await window.openDots?.desktopPermissions?.(action);
      if (value) setPermissions(value);
    } catch { setError(t("appSettings.permissions.error.openCheck")); }
    finally { setBusy(false); }
  }
  if (!permissions?.supported && !error) return null;
  return <section className="space-y-3 rounded-lg border border-line p-4 text-sm">
    <h3 className="font-semibold">{t("appSettings.permissions.title")}</h3><p className="text-xs text-muted">{t("appSettings.permissions.description")}</p>
    {permissions && <ul className="space-y-2"><li>{t("appSettings.permissions.accessibility")}: {permissions.accessibility ? t("appSettings.permissions.granted") : t("appSettings.permissions.notGranted")} <Button variant="ghost" size="sm" className="ml-2" disabled={busy} onClick={() => void check("accessibility")}>{t("appSettings.permissions.openSettings")}</Button></li><li>{t("appSettings.permissions.screenRecording")}: {permissions.screen_recording ? t("appSettings.permissions.granted") : t("appSettings.permissions.notGranted")} <Button variant="ghost" size="sm" className="ml-2" disabled={busy} onClick={() => void check("screen_recording")}>{t("appSettings.permissions.openSettings")}</Button></li></ul>}
    {error && <Banner tone="danger">{error}</Banner>}<Button size="sm" disabled={busy} onClick={() => void check("status")}>{t("appSettings.permissions.checkAgain")}</Button>
  </section>;
}
