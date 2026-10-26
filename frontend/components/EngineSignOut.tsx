"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:opacity-50";

export function EngineSignOut({ label, disabled, onSignOut, onChanged, onPendingChange }: {
  label: string;
  disabled: boolean;
  onSignOut: () => Promise<void>;
  onChanged: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSignOut();
      setConfirming(false);
      onPendingChange(false);
      onChanged();
    } catch (err) {
      // Keep provider and command output out of the settings UI.
      setError(err instanceof ApiError && err.status === 409
        ? "Could not confirm sign-out. Stop active conversations, finish pending sign-in, and check the engine status or configured API key."
        : `Could not sign out of ${label}. Check the engine status and try again.`);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-2">
    {!confirming ? <button type="button" className={BUTTON} disabled={disabled || busy} onClick={() => { setError(null); setConfirming(true); onPendingChange(true); }}>Sign out of {label}</button> : <div className="space-y-2 rounded-md border border-warning/50 p-3 text-sm">
      <p>This signs {label} out of the shared server CLI account. It can also affect CLI use outside this app. To switch accounts, sign out here, then use the existing sign-in flow.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={disabled || busy} onClick={() => void signOut()}>{busy ? "Signing out…" : `Sign out of ${label}`}</button>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => { setConfirming(false); onPendingChange(false); }}>Keep signed in</button>
      </div>
    </div>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}
