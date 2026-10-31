"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";

type EngineId = "claude" | "codex" | "opencode";
type Operation = {
  id: string;
  engine: EngineId;
  action: "install" | "update";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: string;
  error: string | null;
  output: string;
};
type Status = { engine: EngineId; installed: boolean; operation: Operation | null };


export function EngineInstall({ engine, installed, onChanged }: {
  engine: EngineId;
  installed: boolean;
  onChanged: () => void;
}) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [managedInstalled, setManagedInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onChangedRef = useRef(onChanged);
  const notifiedOperationId = useRef<string | null>(null);
  const running = operation?.status === "queued" || operation?.status === "running";

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const refresh = useCallback(async () => {
    try {
      const result = await request<Status>(`/engine-install/${engine}/status`);
      setOperation(result.operation);
      setManagedInstalled(result.installed);
      setError(null);
      if (result.operation?.status === "succeeded" && notifiedOperationId.current !== result.operation.id) {
        notifiedOperationId.current = result.operation.id;
        onChangedRef.current();
      }
    } catch (err) {
      setError(err instanceof Error ? `Could not check install status. ${err.message}` : "Could not check install status.");
    }
  }, [engine]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(initial);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), 900);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  const start = async (action: "install" | "update") => {
    setBusy(true); setError(null);
    try {
      setOperation(await request<Operation>(`/engine-install/${engine}`, {
        method: "POST", body: JSON.stringify({ action }),
      }));
    } catch (err) {
      setError(err instanceof Error ? `Could not start the install. ${err.message}` : "Could not start the install.");
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setError(null);
    try {
      await request<void>(`/engine-install/${engine}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? `Could not cancel the install. ${err.message}` : "Could not cancel the install.");
    } finally { setBusy(false); }
  };

  return <section className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {!managedInstalled ? <Button type="button" disabled={busy || running} onClick={() => void start("install")}>{installed ? "Install app-managed copy" : "Install"}</Button>
        : <Button type="button" disabled={busy || running} onClick={() => void start("update")}>Update</Button>}
      {running && <Button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</Button>}
      {operation?.status === "failed" && <Button type="button" disabled={busy} onClick={() => void start(managedInstalled ? "update" : "install")}>Retry</Button>}
    </div>
    {installed && !managedInstalled && <p className="text-xs text-muted">The app-managed copy is stored in its own runtime folder. Existing CLI installs outside the app data folder are left in place.</p>}
    {operation && <p role="status" className="text-xs text-muted">{operation.progress}</p>}
    {operation?.error && <Banner tone="warning">{operation.error}</Banner>}
    {error && <Banner tone="warning">{error}</Banner>}
    {operation?.output && <details className="text-xs"><summary className="cursor-pointer">Installer output</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted">{operation.output}</pre></details>}
  </section>;
}
