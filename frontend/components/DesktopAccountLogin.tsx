"use client";

import { useState } from "react";
import { request } from "@/lib/api";
import { ThemeToggle } from "./ui/ThemeToggle";

export type DesktopAccountStatus = { signed_in: boolean; email: string | null; account_required: boolean; profile_bound: boolean };

export function DesktopAccountLogin({ status, onSignedIn }: { status: DesktopAccountStatus; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [sent, setSent] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await request("/desktop-account/email/start", { method: "POST", body: JSON.stringify({ email: email.trim(), ...(invite.trim() ? { invite_code: invite.trim() } : {}) }) });
      setSent(true); setCode(""); setNotice("Check your email for a sign-in code. It expires in 10 minutes.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send a code. Try again."); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!sent) { await sendCode(); return; }
    setBusy(true); setError(null);
    try {
      await request("/desktop-account/email/verify", { method: "POST", body: JSON.stringify({ email: email.trim(), code: code.trim(), adopt_local_data: adopt }) });
      setCode(""); onSignedIn();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not verify the code. Try again."); }
    finally { setBusy(false); }
  }

  const field = "mt-1 w-full rounded-md border border-line bg-transparent px-3 py-2";
  const button = "rounded-md border border-line px-4 py-2 disabled:opacity-50";
  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center space-y-5 px-5 py-8">
    <ThemeToggle />
    <div><h1 className="text-2xl font-semibold">Sign in to Open Duet</h1><p className="mt-2 text-sm text-muted">Use your email to sign in or create an account. Connecting Claude or Codex comes next.</p></div>
    <p className="text-sm text-muted">Your agents and files stay on this computer. Account sign-in does not upload them or connect your email inbox.</p>
    <form className="space-y-4" onSubmit={submit}>
      <label className="block text-sm">Email<input className={field} type="email" autoComplete="email" required maxLength={254} disabled={busy || sent} value={email} onChange={event => setEmail(event.target.value)} /></label>
      {!sent && <details><summary className="text-sm">Have an invitation code?</summary><label className="mt-2 block text-sm">Invitation code<input className={field} autoComplete="off" maxLength={256} value={invite} disabled={busy} onChange={event => setInvite(event.target.value)} /></label></details>}
      {sent && <label className="block text-sm">Email code<input className={field} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>}
      {!status.profile_bound && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={adopt} disabled={busy} onChange={event => setAdopt(event.target.checked)} />Use this account for this local profile, including any agents and conversations already saved here.</label>}
      {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button className={button} type="submit" disabled={busy || (sent && !status.profile_bound && !adopt)}>{busy ? "Please wait…" : sent ? "Verify and continue" : "Email me a code"}</button>
      {sent && <div className="flex flex-wrap gap-4 text-sm"><button type="button" className="underline" disabled={busy} onClick={() => void sendCode()}>Resend code</button><button type="button" className="underline" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(null); setNotice(null); }}>Use another email</button></div>}
    </form>
  </main>;
}
