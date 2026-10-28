"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, isSignedOutError, request, setSignedOutHandler } from "@/lib/api";
import { auth } from "@/lib/auth";
import { SIGN_IN_URL } from "@/lib/paths";
import { migrateLegacyIdentity, type SessionInfo } from "@/lib/session";
import { DesktopAccountLogin, type DesktopAccountStatus } from "./DesktopAccountLogin";
import { onboarding } from "@/lib/onboarding";

type SessionContextValue = {
  // null when the server could not say (unreachable, or the desktop app's page
  // opened outside its window): pages then show their own errors.
  session: SessionInfo | null;
  setUserId: (userId: string | null) => void;
};

const SessionContext = createContext<SessionContextValue>({ session: null, setUserId: () => {} });

export function useSession() {
  return useContext(SessionContext);
}

// Renders its children once the browser is known to be signed in (or is the
// desktop app, or trusted on this machine); sends it to the sign-in page otherwise.
export function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [account, setAccount] = useState<DesktopAccountStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [continueWithoutSetup, setContinueWithoutSetup] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    setSignedOutHandler(() => {
      const next = `${window.location.pathname}${window.location.search}`;
      if (SIGN_IN_URL) window.location.replace(`${SIGN_IN_URL}?next=${encodeURIComponent(next)}`);
      else router.replace(`/login/?next=${encodeURIComponent(next)}`);
    });
    (async () => {
      try {
        const status = await auth.status();
        if (status.desktop) {
          const localAccount = await request<DesktopAccountStatus>("/desktop-account/status");
          if (cancelled) return;
          setAccount(localAccount);
          if (!localAccount.signed_in) { setReady(true); return; }
        }
        const current = await auth.session();
        let storage: Storage | null = null;
        try { storage = window.localStorage; } catch { /* storage blocked */ }
        const userId = storage ? await migrateLegacyIdentity(current, storage, auth.setIdentity) : current.user_id;
        if (!cancelled) setSession({ ...current, user_id: userId });
        if (current.scopes.includes("admin") && !["/onboarding", "/settings"].some(page => pathname.replace(/\/$/, "").endsWith(page)) && !continueWithoutSetup) {
          try {
            const progress = await onboarding.get();
            if (progress.status === "pending") { router.replace("/onboarding/"); return; }
          } catch (err) {
            if (!(err instanceof ApiError && [403, 404].includes(err.status))) throw err;
          }
        }
      } catch (err) {
        if (isSignedOutError(err)) return; // the handler is already navigating
        if (!cancelled) setProblem(err instanceof Error ? err.message : "Could not read your sign-in or setup state.");
        return;
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      setSignedOutHandler(null);
    };
  }, [router, pathname, retry, continueWithoutSetup]);

  const setUserId = useCallback((userId: string | null) => {
    setSession((previous) => (previous ? { ...previous, user_id: userId } : previous));
  }, []);

  if (problem) return <main className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-lg font-semibold">Could not open your workspace</h1><p role="alert" className="text-sm">{problem}</p><button className="rounded border border-line px-3 py-2" onClick={() => { setProblem(null); setReady(false); setRetry(value => value + 1); }}>Try again</button>{session && <button className="ml-3 text-sm underline" onClick={() => { setProblem(null); setContinueWithoutSetup(true); }}>Continue without the setup guide</button>}</main>;
  if (!ready) return <p className="p-6 text-center text-sm text-muted">Loading…</p>;
  if (account && !account.signed_in) return <DesktopAccountLogin status={account} onSignedIn={() => { setReady(false); setRetry(value => value + 1); }} />;
  return <SessionContext.Provider value={{ session, setUserId }}>{children}</SessionContext.Provider>;
}
