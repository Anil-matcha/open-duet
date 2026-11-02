"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";


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
    {!confirming ? <Button type="button" disabled={disabled || busy} onClick={() => { setError(null); setConfirming(true); onPendingChange(true); }}>Sign out of {label}</Button> : <div className="space-y-2 rounded-md border border-warning/50 p-3 text-sm">
      <p>This signs {label} out of the shared server CLI account. It can also affect CLI use outside this app. To switch accounts, sign out here, then use the existing sign-in flow.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || busy} onClick={() => void signOut()}>{busy ? "Signing out…" : `Sign out of ${label}`}</Button>
        <Button type="button" disabled={busy} onClick={() => { setConfirming(false); onPendingChange(false); }}>Keep signed in</Button>
      </div>
    </div>}
    {error && <Banner tone="danger">{error}</Banner>}
  </div>;
}
