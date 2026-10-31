"use client";

import { useState } from "react";
import { request } from "@/lib/api";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";

type Kind = "reset" | "delete";

const COPY: Record<Kind, { open: string; word: string; path: string; warning: string }> = {
  reset: {
    open: "Reset this profile",
    word: "RESET",
    path: "/desktop-account/reset-profile",
    warning: "This permanently erases the agents, conversations, memory, routines, settings and saved provider keys on this computer and unlinks it from its account. Remove all cloud computers first; they are separate resources and may incur charges. Your cloud account is not deleted. Engine sign-ins (Claude, Codex) are kept.",
  },
  delete: {
    open: "Delete my account",
    word: "DELETE",
    path: "/desktop-account/delete-account",
    warning: "This permanently deletes your cloud account, then erases everything saved on this computer, including provider keys. Remove all cloud computers first; they are separate resources and may incur charges. It cannot be undone.",
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
      setError(err instanceof Error ? `Could not finish. Nothing was lost; try again. ${err.message}` : "Could not finish. Nothing was lost; try again.");
      setBusy(false);
    }
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>{copy.open}</Button>;
  return <div className="space-y-3 rounded-md border border-line p-4">
    <Banner tone="warning">{copy.warning}</Banner>
    <Field label={`Type ${copy.word} to confirm`}>{(props) => <Input {...props} autoComplete="off" value={typed} disabled={busy} onChange={event => setTyped(event.target.value)} />}</Field>
    {error && <Banner tone="danger">{error}</Banner>}
    <div className="flex gap-3">
      <Button variant="danger" disabled={busy || typed !== copy.word} onClick={() => void run()}>{busy ? "Please wait…" : copy.open}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false); setTyped(""); setError(null); }}>Cancel</Button>
    </div>
  </div>;
}
