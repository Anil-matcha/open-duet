"use client";

import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { BASE_PATH } from "@/lib/paths";
import { safeNextPath, type AuthStatus } from "@/lib/session";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";
import { Skeleton } from "./ui/Skeleton";
import { LanguageSelect } from "@/components/settings/LanguageSelect";
import { useT } from "@/lib/use-i18n";

function nextPath(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get("next"), BASE_PATH);
}

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// A password input with a labelled show/hide control.
function PasswordInput({ id, reveal, onToggle, showLabel, hideLabel, ...rest }: { id: string; reveal: boolean; onToggle: () => void; showLabel: string; hideLabel: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <Input id={id} type={reveal ? "text" : "password"} className="pr-11" {...rest} />
      <button
        type="button"
        onClick={onToggle}
        aria-label={reveal ? hideLabel : showLabel}
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
  const t = useT();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a double submit from a fast double-click or Enter repeat.
  const inFlight = useRef(false);
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
    if (inFlight.current) return;
    setError(null);
    if (settingUp && passphrase !== repeat) {
      setError(t("auth.passphrasesDiffer"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (settingUp) await auth.setup(passphrase);
      else await auth.login(passphrase);
      setSignedIn(true);
      window.location.replace(nextPath());
    } catch (err) {
      setError(message(err, t("auth.signInError")));
      setBusy(false);
      inFlight.current = false;
    }
  };

  const label = signedIn ? t("auth.signedInOpening") : busy ? t("auth.working") : settingUp ? t("auth.setupAndSignIn") : t("auth.signIn");

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-inset px-4">
      <div className="absolute right-4 top-4"><LanguageSelect /></div>
      <main className="w-full max-w-sm space-y-5 rounded-card border border-line bg-raised p-6 shadow-(--shadow-card)">
        <h1 className="text-title font-semibold">{settingUp ? t("auth.titleSetup") : t("auth.titleSignIn")}</h1>
        {problem && <Banner tone="danger">{problem}</Banner>}
        {!status && !problem && (
          <div role="status" className="space-y-3">
            <span className="sr-only">{t("auth.loading")}</span>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        )}
        {settingUp && !status.setup_allowed && (
          <div className="space-y-2 text-sm text-muted">
            <p>{t("auth.setupServerOnly")}</p>
            <pre className="overflow-x-auto rounded bg-inset p-3 text-xs">cd backend{"\n"}uv run python -m app.auth.cli set-passphrase</pre>
            <p>{t("auth.reloadAndSignIn")}</p>
          </div>
        )}
        {status && (!settingUp || status.setup_allowed) && (
          <form onSubmit={submit} className="space-y-4">
            {settingUp && <p className="text-sm text-muted">{t("auth.setupHelp")}</p>}
            <Field label={t("auth.passphrase")}>
              {(props) => (
                <PasswordInput {...props} reveal={reveal} showLabel={t("auth.showPassphrase")} hideLabel={t("auth.hidePassphrase")} onToggle={() => setReveal((v) => !v)} value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete={settingUp ? "new-password" : "current-password"} required minLength={settingUp ? 10 : 1} autoFocus />
              )}
            </Field>
            {settingUp && (
              <Field label={t("auth.repeatPassphrase")}>
                {(props) => (
                  <PasswordInput {...props} reveal={reveal} showLabel={t("auth.showPassphrase")} hideLabel={t("auth.hidePassphrase")} onToggle={() => setReveal((v) => !v)} value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
                )}
              </Field>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            <Button type="submit" variant="primary" className="w-full" loading={busy || signedIn}>{label}</Button>
          </form>
        )}
        {status && !settingUp && (
          <p className="text-xs text-muted">{t("auth.pairingPrompt")} <Link href="/pair/" className="underline">{t("auth.pairBrowser")}</Link>.</p>
        )}
      </main>
    </div>
  );
}
