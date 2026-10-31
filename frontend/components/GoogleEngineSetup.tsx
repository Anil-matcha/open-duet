"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Engine, type GoogleSetupOperation } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Input } from "@/components/ui/Input";


export function GoogleEngineSetup({ engine, onChanged }: { engine: Engine; onChanged: () => void }) {
  const [operation, setOperation] = useState<GoogleSetupOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callback, setCallback] = useState("");
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);

  useEffect(() => {
    let cancelled = false;
    api.googleSetupStatus().then((status) => {
      if (!cancelled && status?.phase === "running") setOperation(status);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (operation?.phase !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.googleSetupStatus();
        if (cancelled) return;
        setOperation(status);
        if (status?.phase !== "running") {
          changed.current();
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? `Could not check Google setup. ${err.message}` : "Could not check Google setup.");
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [operation?.id, operation?.phase]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (err) { setError(err instanceof ApiError ? `Could not complete Google setup. ${err.message}` : "Could not complete Google setup."); }
    finally { setBusy(false); }
  };
  const running = operation?.phase === "running";
  const start = (kind: "install" | "sign_in" | "models") => void act(async () => {
    setCallback("");
    setOperation(await api.startGoogleSetup(kind));
  });

  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      {!engine.installed && <Button type="button" disabled={busy || running} onClick={() => start("install")}>Install Antigravity</Button>}
      {engine.installed && <Button type="button" disabled={busy || running} onClick={() => start("sign_in")}>{engine.signed_in ? "Switch Google account" : "Sign in with Google"}</Button>}
      {engine.signed_in && <>
        <Button type="button" disabled={busy || running} onClick={() => start("models")}>Refresh models</Button>
        <Button type="button" disabled={busy || running} onClick={() => void act(async () => { await api.deleteEngineConfig("antigravity"); setOperation(null); changed.current(); })}>Remove Google account</Button>
      </>}
      {running && <Button type="button" disabled={busy} onClick={() => void act(async () => { await api.cancelGoogleSetup(); setOperation(await api.googleSetupStatus()); setCallback(""); changed.current(); })}>Cancel setup</Button>}
    </div>
    {running && (
      <div className="space-y-2">
        <p role="status" className="text-xs text-muted">
          {operation.detail || (operation.kind === "install" ? "Downloading and verifying the official Google runtime. This can take a few minutes." : operation.kind === "models" ? "Refreshing the models available to your account…" : "Waiting for Google sign-in and loading your models…")}
        </p>
        {operation.progress != null && (
          <div className="w-full bg-line rounded-full h-2 overflow-hidden">
            <div className="bg-accent h-2 rounded-full transition-all duration-200" style={{ width: `${Math.max(4, Math.min(100, operation.progress))}%` }} />
          </div>
        )}
      </div>
    )}
    {running && operation.authorization_url && <div className="space-y-2">
      <Button type="button"  disabled={busy} onClick={() => void act(async () => {
        if (!window.openDots?.openGoogleSignIn) throw new Error("Open this setup in the Open Duet desktop app to continue.");
        await window.openDots.openGoogleSignIn(operation.authorization_url!);
      })}>Continue to Google sign-in</Button>
      <details><summary className="cursor-pointer text-xs">Signing in from another computer?</summary>
        <p className="mt-2 text-xs text-muted">After signing in, copy the complete localhost redirect URL from your browser and paste it below.</p>
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { const value = callback; setCallback(""); await api.completeGoogleSetup(operation.id, value); }); }}>
          <Input aria-label="Google redirect URL" type="password" autoComplete="off" value={callback} onChange={(event) => setCallback(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" disabled={busy || !callback.trim()}>Complete sign-in</Button>
        </form>
      </details>
    </div>}
    {operation?.phase === "succeeded" && <Banner tone="success">{operation.kind === "install" ? "Antigravity installed. Sign in with Google to continue." : "Google account models refreshed."}</Banner>}
    {(error || operation?.error) && <Banner tone="danger">{error || operation?.error}</Banner>}
  </div>;
}
