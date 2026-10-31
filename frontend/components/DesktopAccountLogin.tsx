"use client";

import { useState } from "react";
import { request } from "@/lib/api";
import { ThemeToggle } from "./ui/ThemeToggle";
import { DesktopAccountDanger } from "./DesktopAccountDanger";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field, Input } from "@/components/ui/Input";

export type DesktopAccountStatus = { signed_in: boolean; email: string | null; account_required: boolean; profile_bound: boolean };

export function DesktopAccountLogin({ status, onSignedIn }: { status: DesktopAccountStatus; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await request("/desktop-account/email/start", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setSent(true); setCode(""); setNotice("Check your email for a sign-in code. It expires in 10 minutes.");
    } catch (err) { setError(err instanceof Error ? `Could not send a code. Try again. ${err.message}` : "Could not send a code. Try again."); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!sent) { await sendCode(); return; }
    setBusy(true); setError(null);
    try {
      await request("/desktop-account/email/verify", { method: "POST", body: JSON.stringify({ email: email.trim(), code: code.trim(), adopt_local_data: adopt }) });
      setCode(""); onSignedIn();
    } catch (err) { setError(err instanceof Error ? `Could not verify the code. Try again. ${err.message}` : "Could not verify the code. Try again."); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center space-y-5 px-5 py-8">
    <ThemeToggle />
    <div><h1 className="text-2xl font-semibold">Sign in to Open Duet</h1><p className="mt-2 text-sm text-muted">Use your email to sign in or create an account. Connecting Claude or Codex comes next.</p></div>
    {status.profile_bound && <Banner tone="warning">Your agents and conversations on this computer are locked until you sign in with the account linked to it.</Banner>}
    <p className="text-sm text-muted">Your agents and files stay on this computer. Account sign-in does not upload them or connect your email inbox.</p>
    <form className="space-y-4" onSubmit={submit}>
      <Field label="Email">{(props) => <Input {...props} type="email" autoComplete="email" required maxLength={254} disabled={busy || sent} value={email} onChange={event => setEmail(event.target.value)} />}</Field>
      {sent && <Field label="Email code">{(props) => <Input {...props} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} />}</Field>}
      {!status.profile_bound && <Checkbox label="Use this account for this local profile, including any agents and conversations already saved here." checked={adopt} disabled={busy} onChange={event => setAdopt(event.target.checked)} />}
      {notice && <Banner>{notice}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" disabled={busy || (sent && !status.profile_bound && !adopt)}>{busy ? "Please wait…" : sent ? "Verify and continue" : "Email me a code"}</Button>
      {sent && <div className="flex flex-wrap gap-4 text-sm"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void sendCode()}>Resend code</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(null); setNotice(null); }}>Use another email</Button></div>}
    </form>
    {status.profile_bound && <DesktopAccountDanger kind="reset" onDone={onSignedIn} />}
  </main>;
}
