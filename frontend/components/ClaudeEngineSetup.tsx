"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ClaudeLoginOperation } from "@/lib/api";
import { EngineSignOut } from "./EngineSignOut";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:opacity-50";
const HOSTS = new Set(["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"]);

function trustedLink(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && HOSTS.has(url.hostname) && url.pathname === "/oauth/authorize"
      && !url.username && !url.password && !url.port && !url.hash && !!url.search ? value : null;
  } catch { return null; }
}

export function ClaudeEngineSetup({ onChanged, signedIn }: { onChanged: () => void; signedIn: boolean | null }) {
  const [flow, setFlow] = useState<ClaudeLoginOperation | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  const flowId = flow?.id;
  const phase = flow?.phase;
  useEffect(() => {
    if (!flowId || phase !== "running") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.claudeLoginStatus(flowId);
        if (stopped) return;
        setFlow(next);
        if (next.phase !== "running") { setCode(""); changed.current(); return; }
        timer = setTimeout(() => void poll(), 1500);
      } catch (err) {
        if (!stopped) setError(err instanceof ApiError ? err.message : "Could not check Claude sign-in.");
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [flowId, phase]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not update Claude sign-in."); }
    finally { setBusy(false); }
  };
  const running = flow?.phase === "running";
  const link = trustedLink(flow?.authorization_url);
  return <div className="space-y-2">
    <button className={BUTTON} disabled={busy || running || signOutPending} onClick={() => void act(async () => {
      setCode(""); setFlow(await api.startClaudeEngineLogin());
    })}>Sign in to Claude</button>
    {signedIn && <EngineSignOut label="Claude" disabled={busy || running} onSignOut={api.logoutClaudeEngine} onChanged={onChanged} onPendingChange={setSignOutPending} />}
    {running && <button className={`${BUTTON} ml-2`} disabled={busy} onClick={() => void act(async () => {
      await api.cancelClaudeLogin(flow.id); setCode(""); setFlow(null); changed.current();
    })}>Cancel Claude sign-in</button>}
    {running && !link && <p role="status" className="text-xs text-muted">Preparing Claude sign-in…</p>}
    {running && link && <div className="space-y-2 text-sm">
      <p>Open <a href={link} target="_blank" rel="noreferrer" className="underline">Claude sign-in</a>, then paste the code shown after signing in.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (busy || flow.code_sent) return;
        const pasted = code.trim();
        setCode("");
        void act(async () => {
          await api.completeClaudeLogin(flow.id, pasted);
          setFlow((current) => current?.id === flow.id ? { ...current, code_sent: true } : current);
        });
      }}>
        <label className="block text-xs">Claude authorization code
          <input type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={code}
            disabled={busy || flow.code_sent} onChange={(event) => setCode(event.target.value)}
            className="mt-1 block rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        </label>
        <button className={BUTTON} disabled={busy || flow.code_sent || !code.trim()} type="submit">Submit code</button>
      </form>
      <p className="text-xs text-muted">The code is sent once to the Claude CLI on your server. This sign-in expires in five minutes.</p>
      {flow.code_sent && <p role="status" className="text-xs text-muted">Code submitted. Waiting for Claude to confirm the account…</p>}
    </div>}
    {phase === "succeeded" && <p role="status" className="text-xs text-success">Claude account connected.</p>}
    {(error || flow?.error) && <p role="alert" className="text-xs text-danger">{error || flow?.error}</p>}
  </div>;
}
