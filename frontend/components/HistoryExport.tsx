"use client";

import { useState } from "react";

// Same base as lib/api.ts; the export is a ZIP, which request() cannot read.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

export function HistoryExport() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function exportHistory() {
    setBusy(true); setError(null); setDone(false);
    try {
      const res = await fetch(`${API_BASE}/history/export`, { credentials: "include" });
      if (!res.ok) {
        let message = "Could not export your history. Try again.";
        try {
          const detail = (await res.json())?.detail;
          if (typeof detail?.message === "string") message = detail.message;
          else if (typeof detail === "string") message = detail;
        } catch { /* not JSON */ }
        throw new Error(message);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `open-dots-history-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export your history. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="space-y-3 rounded-lg border border-line p-5">
    <h3 className="font-semibold">Your history</h3>
    <p className="text-xs text-muted">Save a copy of your agents, conversations and attachment names to a ZIP file. It never includes engine sign-ins, your account sign-in or attached files, and it stays on this computer.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {done && <p role="status" className="text-sm text-muted">Export saved to your downloads.</p>}
    <button className="rounded border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void exportHistory()}>{busy ? "Preparing…" : "Export my history"}</button>
  </section>;
}
