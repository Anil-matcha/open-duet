"use client";

import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";

type HostedState = { available: boolean; signedIn: boolean; active: boolean };
type Bridge = { hostedWorkspace?(action: "status" | "open"): Promise<HostedState> };

// Desktop app only, and only while the app offers it: the shell answers "unavailable" otherwise,
// so this card never shows in a browser or in a build with the feature off.
export function HostedWorkspaceCard() {
  const [state, setState] = useState<HostedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = (typeof window === "undefined" ? undefined : (window.openDots as Bridge | undefined));

  useEffect(() => {
    let live = true;
    bridge?.hostedWorkspace?.("status").then(value => { if (live) setState(value); }).catch(() => {});
    return () => { live = false; };
  }, [bridge]);

  if (!state?.available || !bridge?.hostedWorkspace) return null;
  const open = bridge.hostedWorkspace;
  return <section className="mt-6 space-y-3 rounded-lg border border-line p-5">
    <h3 className="font-semibold">Hosted workspace</h3>
    <p className="text-sm">Open your cloud workspace in this window. It uses your hosted agents, conversations and files, not the ones on this computer.</p>
    <p className="text-xs text-muted">You sign in to it separately with your hosted account email and password. Switch back any time from the Workspace menu (Ctrl or Cmd+1 for this computer, +2 for hosted). Nothing is copied between the two.</p>
    {!state.signedIn && <Banner tone="info">Sign in to your app account above first.</Banner>}
    {error && <Banner tone="danger">{error}</Banner>}
    <Button disabled={busy || !state.signedIn} onClick={() => {
      setBusy(true); setError(null);
      void open("open").then(setState).catch(err => setError(err instanceof Error ? `Could not open the hosted workspace. ${err.message}` : "Could not open the hosted workspace.")).finally(() => setBusy(false));
    }}>{busy ? "Opening…" : "Open hosted workspace"}</Button>
  </section>;
}
