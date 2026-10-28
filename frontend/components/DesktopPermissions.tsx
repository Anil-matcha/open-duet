"use client";

import { useEffect, useState } from "react";

type Permissions = { supported: boolean; accessibility: boolean; screen_recording: boolean };

export function DesktopPermissions() {
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => void window.openDots?.desktopPermissions?.("status").then(value => { if (live) { setPermissions(value); setError(null); } }).catch(() => { if (live) setError("Could not check Mac permissions. You can continue and check later."); });
    refresh();
    window.addEventListener("focus", refresh);
    return () => { live = false; window.removeEventListener("focus", refresh); };
  }, []);
  async function check(action: "status" | "accessibility" | "screen_recording") {
    setBusy(true); setError(null);
    try {
      const value = await window.openDots?.desktopPermissions?.(action);
      if (value) setPermissions(value);
    } catch { setError("Could not open or check permissions. Continue now and try again from Settings."); }
    finally { setBusy(false); }
  }
  if (!permissions?.supported && !error) return null;
  return <section className="space-y-3 rounded-lg border border-line p-4 text-sm">
    <h3 className="font-semibold">Mac permissions (optional)</h3><p className="text-xs text-muted">These are only needed for native desktop control. Chat works without them. Enabling them here does not give any agent computer access.</p>
    {permissions && <ul className="space-y-2"><li>Accessibility: {permissions.accessibility ? "Granted" : "Not granted"} <button className="ml-2 underline" disabled={busy} onClick={() => void check("accessibility")}>Open settings</button></li><li>Screen Recording: {permissions.screen_recording ? "Granted" : "Not granted"} <button className="ml-2 underline" disabled={busy} onClick={() => void check("screen_recording")}>Open settings</button></li></ul>}
    {error && <p role="alert" className="text-danger">{error}</p>}<button className="underline" disabled={busy} onClick={() => void check("status")}>Check permissions again</button>
  </section>;
}
