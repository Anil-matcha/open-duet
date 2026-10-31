"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { withBase } from "@/lib/paths";
import { pairingCodeFromHash } from "@/lib/session";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";

// Exchanges a one-time pairing code for this browser's own session. The code
// arrives in the URL fragment (#code=…), which never reaches a server log.
export function PairScreen() {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);

  useEffect(() => {
    const fromLink = pairingCodeFromHash(window.location.hash);
    if (fromLink) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCode(fromLink);
      // Out of the address bar and history once read.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.pair(code, label);
      setPaired(true);
      window.location.replace(withBase("/chat/"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not pair. Check the code and try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-inset px-4">
      <main className="w-full max-w-sm space-y-5 rounded-card border border-line bg-raised p-6 shadow-(--shadow-card)">
        <h1 className="text-title font-semibold">Pair this browser</h1>
        <p className="text-sm text-muted">Enter the code shown in Settings → Account & privacy → Devices on a signed-in browser. Codes work once and expire after five minutes.</p>
        {paired ? (
          <Banner tone="success" title="Paired">Opening your chats…</Banner>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Pairing code">
              {(props) => (
                <Input {...props} className="font-mono uppercase tracking-widest" value={code} onChange={(e) => setCode(e.target.value)}
                  placeholder="ABCD-EFGH" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} required maxLength={32} />
              )}
            </Field>
            <Field label="Name for this device (optional)">
              {(props) => <Input {...props} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My phone" maxLength={80} />}
            </Field>
            {error && <Banner tone="danger">{error}</Banner>}
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!code.trim()}>{busy ? "Pairing…" : "Pair"}</Button>
          </form>
        )}
        <p className="text-xs text-muted">Are you the owner? <Link href="/login/" className="underline">Sign in with the passphrase</Link>.</p>
      </main>
    </div>
  );
}
