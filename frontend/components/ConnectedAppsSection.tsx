"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ComposioStatus } from "@/lib/api";
import {
  POLL_INTERVAL_MS, accountsOf, outcomeFor, pollDeadline, reservePage, statusLabel,
  type ComposioAccount, type ComposioApp, type TabWindow,
} from "@/lib/connected-apps";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "block w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm disabled:opacity-50";

type Waiting = { accountId: string; toolkit: string; expiresIn: number };

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

// Settings: the owner's Composio key, and connecting, listing and disconnecting
// apps. Apps are not yet usable by agents; this only manages the connections.
export function ConnectedAppsSection() {
  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [accounts, setAccounts] = useState<ComposioAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState(false);

  const loadAccounts = useCallback(async () => {
    try { setAccounts(await api.listComposioAccounts()); setError(null); }
    catch (err) { setError(message(err, "Could not load your connected apps.")); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getComposioStatus().then((value) => {
      if (cancelled) return;
      setStatus(value);
      if (value.configured) void loadAccounts();
    }).catch((err: unknown) => { if (!cancelled) setError(message(err, "Could not load connected apps.")); });
    return () => { cancelled = true; };
  }, [loadAccounts]);

  // Waiting for the person to finish in the browser: stops on success, failure,
  // cancel, the link's lifetime, and when this section goes away.
  const accountId = waiting?.accountId;
  const expiresIn = waiting?.expiresIn;
  useEffect(() => {
    if (!accountId || expiresIn === undefined) return;
    const deadline = pollDeadline(expiresIn, Date.now());
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api.listComposioAccounts();
        if (cancelled) return;
        setAccounts(latest);
        const outcome = outcomeFor(latest, accountId);
        if (outcome === "connected") { setWaiting(null); setNotice("App connected."); return; }
        if (outcome === "failed") { setWaiting(null); setError("The connection did not complete. Remove it below and try again."); return; }
        if (outcome === "gone") { setWaiting(null); setError("That connection is no longer there."); return; }
      } catch (err) {
        if (cancelled) return;
        setWaiting(null); setError(message(err, "Could not check the connection.")); return;
      }
      if (Date.now() > deadline) { setWaiting(null); setError("The connect link expired before it was finished. Try again."); return; }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, expiresIn]);

  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("key"); setError(null); setNotice(null);
    try {
      const saved = await api.saveComposioKey(keyDraft.trim());
      setKeyDraft(""); setReplacing(false); setStatus(saved); setAccounts(null); setWaiting(null);
      setNotice("Key saved.");
      await loadAccounts();
    } catch (err) { setError(message(err, "Could not save the key.")); }
    finally { setBusy(null); }
  };

  const removeKey = async () => {
    setBusy("key"); setError(null); setNotice(null);
    try {
      await api.deleteComposioKey();
      setStatus((previous) => previous && { ...previous, configured: false });
      setAccounts(null); setWaiting(null); setRemovingKey(false);
      setNotice("Key removed from this app. Connected accounts were not revoked at Composio.");
    } catch (err) { setError(message(err, "Could not remove the key.")); }
    finally { setBusy(null); }
  };

  const connect = async (app: ComposioApp) => {
    setBusy(`connect:${app.slug}`); setError(null); setNotice(null);
    // Opened now, during the click, so a browser does not block it.
    const page = reservePage(window.openDots, (url, target) => window.open(url, target) as TabWindow | null);
    try {
      const link = await api.connectComposioApp(app.slug, names[app.slug]?.trim() || undefined);
      await page.navigate(link.redirect_url);
      setNames((previous) => ({ ...previous, [app.slug]: "" }));
      setWaiting({ accountId: link.account_id, toolkit: app.slug, expiresIn: link.expires_in_seconds });
      await loadAccounts();
    } catch (err) { page.cancel(); setError(message(err, "Could not start the connection.")); }
    finally { setBusy(null); }
  };

  const disconnect = async (account: ComposioAccount) => {
    setBusy(`remove:${account.id}`); setError(null); setNotice(null);
    try {
      await api.disconnectComposioAccount(account.id);
      setConfirming(null);
      if (waiting?.accountId === account.id) setWaiting(null);
      setNotice("Disconnected.");
      await loadAccounts();
    } catch (err) { setError(message(err, "Could not disconnect. Try again.")); }
    finally { setBusy(null); }
  };

  const showKeyForm = status !== null && (!status.configured || replacing);
  return <section aria-labelledby="connected-apps-title" className="space-y-4 rounded-lg border border-line p-5">
    <div>
      <h3 id="connected-apps-title" className="font-semibold">Connected apps</h3>
      <p className="mt-1 text-xs text-muted">Connect apps through your own Composio account. Your key is stored encrypted on this computer and never shown again. Agents cannot use these apps yet.</p>
    </div>
    {error && <p role="alert" className="rounded-md border border-danger/50 p-3 text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="rounded-md border border-line p-3 text-sm">{notice}</p>}
    {!status && !error && <p role="status" className="text-sm text-muted">Loading…</p>}

    {showKeyForm && <form onSubmit={saveKey} className="space-y-2">
      <label htmlFor="composio-key" className="block text-sm font-medium">{status.configured ? "New Composio project key" : "Composio project key"}</label>
      <input id="composio-key" type="password" className={FIELD} value={keyDraft} disabled={busy !== null} required minLength={11}
        onChange={(event) => setKeyDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder="ak_…" />
      <p className="text-xs text-muted">Create a project key in your Composio dashboard (it starts with <code>ak_</code>). The key is checked with Composio before it is saved.</p>
      <div className="flex gap-2">
        <button type="submit" className={BUTTON} disabled={busy !== null || keyDraft.trim().length < 11}>{busy === "key" ? "Checking…" : "Save key"}</button>
        {replacing && <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => { setReplacing(false); setKeyDraft(""); }}>Cancel</button>}
      </div>
    </form>}

    {status?.configured && <>
      {accounts === null && !error && <p role="status" className="text-sm text-muted">Loading your apps…</p>}
      <ul className="space-y-3">
        {status.apps.map((app) => {
          const mine = accountsOf(accounts ?? [], app.slug);
          const connecting = waiting?.toolkit === app.slug;
          return <li key={app.slug} className="space-y-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{app.label}</span>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`name-${app.slug}`}>Name for a new {app.label} account (optional)</label>
                <input id={`name-${app.slug}`} className="w-40 rounded-md border border-line bg-transparent px-2 py-1 text-sm disabled:opacity-50" placeholder="Name (optional)" maxLength={40}
                  value={names[app.slug] ?? ""} disabled={busy !== null || waiting !== null} autoComplete="off"
                  onChange={(event) => setNames((previous) => ({ ...previous, [app.slug]: event.target.value }))} />
                <button type="button" className={BUTTON} disabled={busy !== null || waiting !== null || accounts === null} onClick={() => void connect(app)}>
                  {busy === `connect:${app.slug}` ? "Opening…" : mine.length ? "Add another" : "Connect"}
                </button>
              </div>
            </div>
            {connecting && <p role="status" className="text-xs text-muted">
              Finish connecting {app.label} in your browser. This page notices when you are done.{" "}
              <button type="button" className="underline" onClick={() => { setWaiting(null); setNotice("Stopped waiting. A pending connection can be removed below; nothing was revoked."); }}>Stop waiting</button>
            </p>}
            {mine.length > 0 && <ul className="divide-y divide-line text-sm">
              {mine.map((account) => <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{account.alias ?? account.id} <span className="text-xs text-muted">· {statusLabel(account.status)}</span></span>
                {confirming === account.id
                  ? <span className="flex items-center gap-2 text-xs">Disconnect this account?
                      <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void disconnect(account)}>{busy === `remove:${account.id}` ? "Working…" : "Disconnect"}</button>
                      <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button></span>
                  : <button type="button" className={BUTTON} disabled={busy !== null} aria-label={`Disconnect ${account.alias ?? account.id}`} onClick={() => setConfirming(account.id)}>Disconnect</button>}
              </li>)}
            </ul>}
          </li>;
        })}
      </ul>
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {!replacing && <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setReplacing(true)}>Replace key</button>}
        {removingKey
          ? <span className="flex flex-wrap items-center gap-2 text-xs">Remove the key from this app? Connected accounts stay at Composio; disconnect them first to revoke them.
              <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void removeKey()}>Remove key</button>
              <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setRemovingKey(false)}>Keep</button></span>
          : <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setRemovingKey(true)}>Remove key</button>}
      </div>
    </>}
  </section>;
}
