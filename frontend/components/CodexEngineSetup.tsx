"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type CodexLoginOperation } from "@/lib/api";
import { EngineSignOut } from "./EngineSignOut";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";


export function CodexEngineSetup({ onChanged, signedIn }: { onChanged: () => void; signedIn: boolean | null }) {
  const [flow, setFlow] = useState<CodexLoginOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);

  const flowId = flow?.id;
  const flowPhase = flow?.phase;
  useEffect(() => {
    if (!flowId || flowPhase !== "running") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await api.codexLoginStatus(flowId);
        if (cancelled) return;
        setFlow(status);
        if (status.phase !== "running") { changed.current(); return; }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? `Could not check Codex sign-in. ${err.message}` : "Could not check Codex sign-in.");
        return;
      }
      timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [flowId, flowPhase]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (err) { setError(err instanceof ApiError ? `Could not update Codex sign-in. ${err.message}` : "Could not update Codex sign-in."); }
    finally { setBusy(false); }
  };
  const running = flow?.phase === "running";
  return <div className="space-y-2">
    <Button disabled={busy || running || signOutPending} onClick={() => void act(async () => setFlow(await api.startCodexLogin()))}>Sign in to Codex</Button>
    {signedIn && <EngineSignOut label="Codex" disabled={busy || running} onSignOut={api.logoutCodexEngine} onChanged={onChanged} onPendingChange={setSignOutPending} />}
    {running && <Button className="ml-2" disabled={busy} onClick={() => void act(async () => {
      await api.cancelCodexLogin(flow.id); setFlow(null); changed.current();
    })}>Cancel sign-in</Button>}
    {running && !flow.user_code && <p role="status" className="text-xs text-muted">Preparing a device code…</p>}
    {running && flow.authorization_url === "https://auth.openai.com/codex/device" && flow.user_code && <div className="space-y-2 text-sm">
      <p>Open <a href={flow.authorization_url} onClick={event => {
        if (!window.openDots?.openEngineSignIn) return;
        event.preventDefault();
        void window.openDots.openEngineSignIn(flow.authorization_url!).catch(() => setError("Could not open your browser. Try signing in again."));
      }} target="_blank" rel="noreferrer" className="underline">ChatGPT device sign-in</a> and enter <code className="select-all font-semibold">{flow.user_code}</code>.</p>
      <p className="text-xs text-muted">Enable device-code login in your ChatGPT security settings if prompted. This code expires in five minutes.</p>
    </div>}
    {flow?.phase === "succeeded" && <Banner tone="success">Codex account connected.</Banner>}
    {(error || flow?.error) && <Banner tone="danger">{error || flow?.error}</Banner>}
  </div>;
}
