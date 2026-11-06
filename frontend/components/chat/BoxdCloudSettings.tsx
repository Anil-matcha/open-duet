"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

const FIELD = "w-full rounded-md border border-line bg-transparent px-2 py-1 text-sm placeholder:text-muted";
const SMALL = "cursor-pointer rounded border border-line px-2 py-1 text-xs disabled:opacity-50";

/** The boxd key form shown when "Cloud (boxd)" is chosen for a new computer. */
export function BoxdCloudSettings({ configured, busy, onConfigured, onBusy, onError }: {
  configured: boolean | null;
  busy: boolean;
  onConfigured: (configured: boolean) => void;
  onBusy: (busy: boolean) => void;
  onError: (error: string | null) => void;
}) {
  const [key, setKey] = useState("");

  const run = async (action: () => Promise<void>) => {
    onBusy(true);
    onError(null);
    try {
      await action();
    } catch (err) {
      onError(err instanceof ApiError || err instanceof Error ? err.message : "The boxd key could not be saved.");
    } finally {
      onBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <p className="text-xs text-muted">
        boxd computers are full Linux virtual machines in your{" "}
        <a className="text-accent underline underline-offset-2 hover:opacity-80" href="https://boxd.sh/?ref=open-duet" target="_blank" rel="noreferrer">boxd</a>{" "}
        account. They have internet access and may incur usage charges. Stopping one hibernates it (memory and disk are kept) and a later turn wakes it in about a second when auto-start is enabled. Commands and files go to the machine; screenshots can be returned to the selected engine. Its files are not synced with this machine&apos;s workspace. The API key is encrypted in this Desktop profile and used by the local backend only to call the boxd API; it is not sent to the agent or the machine.
      </p>
      <p className="text-xs text-muted">
        {configured ? "boxd API key saved on this device. Enter a new key to replace it." : "Add a boxd API key (boxd.sh console, API keys) to enable boxd computers."}
      </p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!key.trim()) return;
        void run(async () => {
          await api.saveBoxdCredential(key.trim());
          onConfigured(true);
          setKey("");
        });
      }}>
        <input type="password" autoComplete="off" spellCheck={false} aria-label="boxd API key" placeholder="boxd API key" value={key} onChange={(event) => setKey(event.target.value)} className={`${FIELD} min-w-48 flex-1`} />
        <button type="submit" disabled={busy || !key.trim()} className={SMALL}>Save key on this device</button>
      </form>
      {configured && <button type="button" disabled={busy} className={SMALL} onClick={() => void run(async () => {
        await api.deleteBoxdCredential();
        onConfigured(false);
        setKey("");
      })}>Remove saved key</button>}
    </div>
  );
}
