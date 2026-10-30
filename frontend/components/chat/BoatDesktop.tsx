"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

const BUTTON = "cursor-pointer rounded border border-line px-2 py-1 text-xs disabled:opacity-50";

export function BoatDesktop({ computerId }: { computerId: number }) {
  const [lease, setLease] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaseRef = useRef<string | null>(null);

  const release = useCallback(() => {
    const current = leaseRef.current;
    leaseRef.current = null;
    setLease(null);
    setUrl(null);
    if (current) void api.releaseComputerControl(computerId, current).catch(() => {});
  }, [computerId]);

  useEffect(() => {
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [release]);

  useEffect(() => {
    if (!lease) return;
    const timer = setInterval(() => {
      void api.computerControlHeartbeat(computerId, lease).catch(() => {
        setError("Control was handed back or this view lost its lease.");
        release();
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [computerId, lease, release]);

  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.takeComputerControl(computerId, leaseRef.current ?? undefined);
      const token = result.lease_id ?? leaseRef.current;
      if (!result.owned || !token) {
        setError("Another view has control. Ask it to hand control back.");
        return;
      }
      leaseRef.current = token;
      setLease(token);
      const desktop = await api.boatDesktopUrl(computerId, token);
      setUrl(desktop.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not open the cloud desktop.";
      setError(message);
      release();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!lease ? (
          <button className={BUTTON} disabled={busy} onClick={() => void take()}>
            {busy ? "Opening cloud desktop…" : "Take control"}
          </button>
        ) : (
          <>
            <span className="text-xs">You are in control of the cloud desktop</span>
            <button className={BUTTON} onClick={release}>Hand control back</button>
            {!url && <button className={BUTTON} disabled={busy} onClick={() => void take()}>Retry connection</button>}
          </>
        )}
      </div>
      {url && lease && (
        <>
          <iframe
            src={url}
            title="Cloud computer desktop"
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write; fullscreen"
            allowFullScreen
            className="aspect-[16/10] min-h-[320px] w-full rounded border border-line bg-black"
          />
          <p className="text-xs text-muted">
            This provider-issued desktop link is secret. Open Dots clears it from this view when you hand control back, but the provider does not expose a link revocation control.
          </p>
        </>
      )}
      {error && <p role="status" className="text-xs text-warning">{error}</p>}
    </section>
  );
}
