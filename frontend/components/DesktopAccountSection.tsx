"use client";

import { useEffect, useState } from "react";
import { ApiError, request } from "@/lib/api";
import type { DesktopAccountStatus } from "./DesktopAccountLogin";
import { DesktopAccountDanger } from "./DesktopAccountDanger";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";

export function DesktopAccountSection() {
  const [account, setAccount] = useState<DesktopAccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    request<DesktopAccountStatus>("/desktop-account/status").then(value => { if (live) setAccount(value); }).catch(err => {
      if (live && !(err instanceof ApiError && err.status === 404)) setError(err instanceof Error ? `Could not read your account. ${err.message}` : "Could not read your account.");
    });
    return () => { live = false; };
  }, []);
  if (!account && !error) return null;
  return <section className="space-y-3 rounded-lg border border-line p-5"><h3 className="font-semibold">App account</h3>
    {account && <p className="text-sm">{account.signed_in ? `Signed in as ${account.email}` : "Signed out"}</p>}
    <p className="text-xs text-muted">Signing out locks this local profile. Your agents, conversations and engine credentials stay on this computer and remain bound to this account.</p>
    {error && <Banner tone="danger">{error}</Banner>}
    {account?.signed_in && <Button disabled={busy} onClick={() => {
      setBusy(true); setError(null);
      void request<{ revoked: boolean }>("/desktop-account/logout", { method: "POST" }).then(() => window.location.reload()).catch(err => { setError(err instanceof Error ? `Could not sign out. ${err.message}` : "Could not sign out."); setBusy(false); });
    }}>{busy ? "Signing out…" : "Sign out of app account"}</Button>}
    {account?.signed_in && <div className="space-y-2"><DesktopAccountDanger kind="reset" onDone={() => window.location.reload()} /><DesktopAccountDanger kind="delete" onDone={() => window.location.reload()} /></div>}
  </section>;
}
