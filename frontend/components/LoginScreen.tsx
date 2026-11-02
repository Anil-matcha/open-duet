"use client";

import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { BASE_PATH } from "@/lib/paths";
import { safeNextPath, type AuthStatus } from "@/lib/session";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";
import { Skeleton } from "./ui/Skeleton";

function nextPath(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get("next"), BASE_PATH);
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// A password input with a labelled show/hide control.
function PasswordInput({ id, reveal, onToggle, ...rest }: { id: string; reveal: boolean; onToggle: () => void } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <Input id={id} type={reveal ? "text" : "password"} className="pr-11" {...rest} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={reveal ? "Hide passphrase" : "Show passphrase"}
        aria-pressed={reveal}
        className="absolute inset-y-0 right-0 inline-flex w-10 cursor-pointer items-center justify-center rounded-r-field text-muted hover:text-ink"
      >
        {reveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </div>
  );
}

// Sign-in, or first-run setup of the owner passphrase (docs/AUTH.md).
export function LoginScreen() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    auth.status().then((value) => {
      if (cancelled) return;
      // Already signed in, or the desktop app (which never signs in): go on.
      if (value.signed_in || value.desktop) window.location.replace(nextPath());
      else setStatus(value);
    }).catch((err: unknown) => {
      if (!cancelled) setProblem(message(err, `Cannot reach the backend from ${window.location.origin}. Check that it is running and that this address is in FRONTEND_ORIGINS.`));
    });
    return () => { cancelled = true; };
  }, []);

  const settingUp = status !== null && !status.owner_configured;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (settingUp && passphrase !== repeat) {
      setError("The two passphrases differ.");
      return;
    }
    setBusy(true);
    try {
      if (settingUp) await auth.setup(passphrase);
      else await auth.login(passphrase);
      setSignedIn(true);
      window.location.replace(nextPath());
    } catch (err) {
      setError(message(err, "Could not sign in. Try again."));
      setBusy(false);
    }
  };

  const label = signedIn ? "Signed in. Opening…" : busy ? "Working…" : settingUp ? "Set passphrase and sign in" : "Sign in";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-inset px-4">
      <main className="w-full max-w-sm space-y-5 rounded-card border border-line bg-raised p-6 shadow-(--shadow-card)">
        <h1 className="text-title font-semibold">{settingUp ? "Set the owner passphrase" : "Sign in to Open Duet"}</h1>
        {problem && <Banner tone="danger">{problem}</Banner>}
        {!status && !problem && (
          <div role="status" className="space-y-3">
            <span className="sr-only">Loading…</span>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        )}
        {settingUp && !status.setup_allowed && (
          <div className="space-y-2 text-sm text-muted">
            <p>No owner passphrase is set yet, and it can only be set from the server itself. On the server, run:</p>
            <pre className="overflow-x-auto rounded bg-inset p-3 text-xs">cd backend{"\n"}uv run python -m app.auth.cli set-passphrase</pre>
            <p>Then reload this page and sign in.</p>
          </div>
        )}
        {status && (!settingUp || status.setup_allowed) && (
          <form onSubmit={submit} className="space-y-4">
            {settingUp && <p className="text-sm text-muted">This passphrase protects this server. Use at least 10 characters; you will sign in with it on every new browser.</p>}
            <Field label="Passphrase">
              {(props) => (
                <PasswordInput {...props} reveal={reveal} onToggle={() => setReveal((v) => !v)} value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete={settingUp ? "new-password" : "current-password"} required minLength={settingUp ? 10 : 1} autoFocus />
              )}
            </Field>
            {settingUp && (
              <Field label="Repeat it">
                {(props) => (
                  <PasswordInput {...props} reveal={reveal} onToggle={() => setReveal((v) => !v)} value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
                )}
              </Field>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            <Button type="submit" variant="primary" className="w-full" loading={busy || signedIn}>{label}</Button>
          </form>
        )}
        {status && !settingUp && (
          <p className="text-xs text-muted">Have a pairing code from Settings → Devices? <Link href="/pair/" className="underline">Pair this browser</Link>.</p>
        )}
      </main>
    </div>
  );
}
