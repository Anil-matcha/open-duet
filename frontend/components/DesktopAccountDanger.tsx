"use client";

import { useState } from "react";
import { request } from "@/lib/api";

type Kind = "reset" | "delete";

const COPY: Record<Kind, { open: string; word: string; path: string; warning: string }> = {
  reset: {
    open: "Reset this profile",
    word: "RESET",
    path: "/desktop-account/reset-profile",
    warning: "This permanently erases the agents, conversations, memory, routines and settings saved on this computer and unlinks it from its account. Your cloud account is not deleted. Engine sign-ins (Claude, Codex) are kept.",
  },
  delete: {
    open: "Delete my account",
    word: "DELETE",
    path: "/desktop-account/delete-account",
    warning: "This permanently deletes your cloud account, then erases everything saved on this computer. It cannot be undone.",
  },
};

// Explicit, typed confirmation for the two actions that erase local data. Sign-out never does.
export function DesktopAccountDanger({ kind, onDone }: { kind: Kind; onDone: () => void }) {
  const copy = COPY[kind];
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      await request(copy.path, { method: "POST", body: JSON.stringify({ confirm: copy.word }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish. Nothing was lost; try again.");
      setBusy(false);
    }
  }

  if (!open) return <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>{copy.open}</button>;
  return <div className="space-y-3 rounded-md border border-line p-4">
    <p role="alert" className="text-sm">{copy.warning}</p>
    <label className="block text-sm">Type {copy.word} to confirm
      <input className="mt-1 w-full rounded-md border border-line bg-transparent px-3 py-2" autoComplete="off" value={typed} disabled={busy} onChange={event => setTyped(event.target.value)} />
    </label>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="flex gap-3">
      <button type="button" className="rounded-md border border-line px-4 py-2 text-sm disabled:opacity-50" disabled={busy || typed !== copy.word} onClick={() => void run()}>{busy ? "Please wait…" : copy.open}</button>
      <button type="button" className="text-sm underline" disabled={busy} onClick={() => { setOpen(false); setTyped(""); setError(null); }}>Cancel</button>
    </div>
  </div>;
}
