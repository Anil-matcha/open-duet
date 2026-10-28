"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type ComposioStatus } from "@/lib/api";
import {
  NO_FILTER, cardState, categoriesOf, connectedSlugs, filterActive, filterApps, toolCounts, unsupportedAccounts,
  type AppFilter, type CardState, type CatalogApp,
} from "@/lib/apps-catalog";
import {
  POLL_INTERVAL_MS, accountsOf, outcomeFor, pollDeadline, reservePage, statusLabel,
  type ComposioAccount, type TabWindow,
} from "@/lib/connected-apps";
import { Badge } from "@/components/ui/Badge";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "block w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm disabled:opacity-50";
const CHIP = "cursor-pointer rounded-full border border-line px-3 py-1 text-sm hover:bg-hover";
const CHIP_ON = "cursor-pointer rounded-full border border-ink bg-ink px-3 py-1 text-sm text-surface";

type Waiting = { accountId: string; toolkit: string; expiresIn: number };

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

const STATE_BADGE: Record<CardState, { tone: "neutral" | "success" | "warning" | "danger"; label: string }> = {
  no_key: { tone: "neutral", label: "Needs your Composio key" },
  not_connected: { tone: "neutral", label: "Not connected" },
  pending: { tone: "warning", label: "Finish connecting" },
  connected: { tone: "success", label: "Connected" },
  failed: { tone: "danger", label: "Connection failed" },
};

// The Apps page: the apps agents can use, connecting and disconnecting them, and the
// owner's Composio key. Agent access is granted separately in each eligible agent's settings.
export function AppsApp() {
  return <div className="min-h-dvh">
    <header className="flex h-12 items-center gap-4 border-b border-line px-4"><Link href="/chat/" className="text-sm text-muted hover:underline">← Chat</Link><h1 className="text-sm font-semibold">Apps</h1></header>
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-8">
      <div>
        <h2 className="text-xl font-semibold">Apps</h2>
        <p className="mt-2 text-sm text-muted">Connect an app once, then choose which agents may use it under Agents → choose an agent → Connected apps. Connecting an app does not give any agent access. Agents can use an allowed app only in conversations you start.</p>
      </div>
      <AppsBrowser />
    </main>
  </div>;
}

function AppsBrowser() {
  const [catalog, setCatalog] = useState<CatalogApp[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AppFilter>(NO_FILTER);
  const [open, setOpen] = useState<string | null>(null);
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

  const [catalogTick, setCatalogTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.getComposioCatalog()
      .then((value) => { if (!cancelled) { setCatalog(value); setCatalogError(null); } })
      .catch((err: unknown) => { if (!cancelled) setCatalogError(message(err, "Could not load the apps.")); });
    return () => { cancelled = true; };
  }, [catalogTick]);

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
  // cancel, the link's lifetime, and when this page goes away.
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

  const connect = async (app: CatalogApp) => {
    setBusy(`connect:${app.app}`); setError(null); setNotice(null);
    // Opened now, during the click, so a browser does not block it.
    const page = reservePage(window.openDots, (url, target) => window.open(url, target) as TabWindow | null);
    try {
      const link = await api.connectComposioApp(app.app, names[app.app]?.trim() || undefined);
      await page.navigate(link.redirect_url);
      setNames((previous) => ({ ...previous, [app.app]: "" }));
      setWaiting({ accountId: link.account_id, toolkit: app.app, expiresIn: link.expires_in_seconds });
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

  const configured = status?.configured === true;
  const showKeyForm = status !== null && (!configured || replacing);
  const mineOf = (slug: string) => accountsOf(accounts ?? [], slug);
  const shown = catalog ? filterApps(catalog, filter, connectedSlugs(accounts)) : [];
  // An app with any account sits under Connected; the rest are grouped by category, never twice.
  const withAccounts = shown.filter((app) => mineOf(app.app).length > 0);
  const others = shown.filter((app) => mineOf(app.app).length === 0);
  const groups = categoriesOf(others).map((category) => ({ category, apps: others.filter((app) => app.category === category) }));
  const strays = catalog ? unsupportedAccounts(accounts ?? [], catalog) : [];

  const accountRow = (account: ComposioAccount) => <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
    <span>{account.alias ?? account.id} <span className="text-xs text-muted">· {statusLabel(account.status)}</span></span>
    {confirming === account.id
      ? <span className="flex items-center gap-2 text-xs">Disconnect this account?
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void disconnect(account)}>{busy === `remove:${account.id}` ? "Working…" : "Disconnect"}</button>
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button></span>
      : <button type="button" className={BUTTON} disabled={busy !== null} aria-label={`Disconnect ${account.alias ?? account.id}`} onClick={() => setConfirming(account.id)}>Disconnect</button>}
  </li>;

  const card = (app: CatalogApp) => {
    const mine = mineOf(app.app);
    const state = cardState(configured, mine);
    const badge = STATE_BADGE[state];
    const counts = toolCounts(app);
    const connecting = waiting?.toolkit === app.app;
    const detailsId = `app-tools-${app.app}`;
    return <li key={app.app} className="space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{app.name}</h4><Badge tone={badge.tone}>{badge.label}</Badge></div>
          <p className="mt-1 text-sm text-muted">{app.description}</p>
          <p className="mt-1 text-xs text-muted">{counts.read} read{counts.write ? ` · ${counts.write} that change things` : " · read only"}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`name-${app.app}`}>Name for a new {app.name} account (optional)</label>
          <input id={`name-${app.app}`} className="w-36 rounded-md border border-line bg-transparent px-2 py-1 text-sm disabled:opacity-50" placeholder="Name (optional)" maxLength={40}
            value={names[app.app] ?? ""} disabled={busy !== null || waiting !== null || !configured} autoComplete="off"
            onChange={(event) => setNames((previous) => ({ ...previous, [app.app]: event.target.value }))} />
          <button type="button" className={BUTTON} title={configured ? undefined : "Save your Composio key first"}
            disabled={busy !== null || waiting !== null || !configured || accounts === null} onClick={() => void connect(app)}>
            {busy === `connect:${app.app}` ? "Opening…" : mine.length ? "Add another" : "Connect"}
          </button>
        </div>
      </div>
      {connecting && <p role="status" className="text-xs text-muted">
        Finish connecting {app.name} in your browser. This page notices when you are done.{" "}
        <button type="button" className="underline" onClick={() => { setWaiting(null); setNotice("Stopped waiting. A pending connection can be removed below; nothing was revoked."); }}>Stop waiting</button>
      </p>}
      {mine.length > 0 && <ul className="divide-y divide-line text-sm">{mine.map(accountRow)}</ul>}
      <div>
        <button type="button" className="cursor-pointer text-sm underline" aria-expanded={open === app.app} aria-controls={detailsId}
          onClick={() => setOpen(open === app.app ? null : app.app)}>{open === app.app ? "Hide what agents can do" : "What agents can do"}</button>
        {open === app.app && <div id={detailsId} className="mt-3 space-y-2">
          <p className="text-xs text-muted">Write access also includes the reads. Every change asks you first on an approval card. Allow {app.name} for an agent in that agent&apos;s settings; connecting it here does not.</p>
          <ul className="divide-y divide-line text-sm">
            {app.tools.map((tool) => <li key={tool.name} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0 text-muted">{tool.description}</span>
              <Badge tone={tool.kind === "write" ? "warning" : "neutral"} className="shrink-0">{tool.kind === "write" ? "Write" : "Read"}</Badge>
            </li>)}
          </ul>
        </div>}
      </div>
    </li>;
  };

  return <div className="space-y-6">
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/50 p-3 text-sm text-danger">
      <span>{error}</span>
      {configured && accounts === null && <button type="button" className={BUTTON} onClick={() => void loadAccounts()}>Try again</button>}
    </div>}
    {notice && <p role="status" className="rounded-md border border-line p-3 text-sm">{notice}</p>}
    {!status && !error && <p role="status" className="text-sm text-muted">Loading…</p>}

    {showKeyForm && <section aria-labelledby="composio-key-title" className="rounded-lg border border-line p-5">
      <form onSubmit={saveKey} className="space-y-2">
        <h3 id="composio-key-title" className="font-semibold">{configured ? "New Composio project key" : "Connect your Composio account"}</h3>
        {!configured && <p className="text-sm text-muted">The apps are listed below. To connect one, add your own Composio project key. It is stored encrypted on this computer and never shown again.</p>}
        <label htmlFor="composio-key" className="sr-only">Composio project key</label>
        <input id="composio-key" type="password" className={FIELD} value={keyDraft} disabled={busy !== null} required minLength={11}
          onChange={(event) => setKeyDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder="ak_…" />
        <p className="text-xs text-muted">Create a project key in your Composio dashboard (it starts with <code>ak_</code>). The key is checked with Composio before it is saved. A scoped key needs Connected accounts: Read, Session management: Write, and Session tool execution: Write. Add Connected accounts: Write to disconnect accounts. Composio fixes scopes when you create a key, so make a new key after changing them.</p>
        <div className="flex gap-2">
          <button type="submit" className={BUTTON} disabled={busy !== null || keyDraft.trim().length < 11}>{busy === "key" ? "Checking…" : "Save key"}</button>
          {replacing && <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => { setReplacing(false); setKeyDraft(""); }}>Cancel</button>}
        </div>
      </form>
    </section>}

    {catalogError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/50 p-3 text-sm text-danger">
      <span>{catalogError}</span><button type="button" className={BUTTON} onClick={() => setCatalogTick((n) => n + 1)}>Try again</button>
    </div>}
    {!catalog && !catalogError && <p role="status" className="text-sm text-muted">Loading apps…</p>}

    {catalog && <>
      <div className="space-y-3">
        <label htmlFor="apps-search" className="sr-only">Search apps</label>
        <input id="apps-search" type="search" className={FIELD} placeholder="Search apps" value={filter.search} autoComplete="off"
          onChange={(event) => setFilter({ ...filter, search: event.target.value })} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter apps">
          <button type="button" className={!filter.category && !filter.connectedOnly ? CHIP_ON : CHIP} aria-pressed={!filter.category && !filter.connectedOnly}
            onClick={() => setFilter({ ...filter, category: null, connectedOnly: false })}>All</button>
          {configured && <button type="button" className={filter.connectedOnly ? CHIP_ON : CHIP} aria-pressed={filter.connectedOnly}
            onClick={() => setFilter({ ...filter, category: null, connectedOnly: !filter.connectedOnly })}>Connected</button>}
          {categoriesOf(catalog).map((category) => <button key={category} type="button" className={filter.category === category ? CHIP_ON : CHIP} aria-pressed={filter.category === category}
            onClick={() => setFilter({ ...filter, category: filter.category === category ? null : category, connectedOnly: false })}>{category}</button>)}
        </div>
      </div>

      {shown.length === 0 && <div className="rounded-md border border-line p-4 text-sm text-muted">
        {catalog.length === 0 ? "No apps are available in this version." : "No apps match."}
        {filterActive(filter) && <> <button type="button" className="underline" onClick={() => setFilter(NO_FILTER)}>Reset filters</button></>}
      </div>}

      {configured && accounts === null && !error && <p role="status" className="text-sm text-muted">Loading your apps…</p>}

      {withAccounts.length > 0 && <section aria-labelledby="apps-connected" className="space-y-3">
        <h3 id="apps-connected" className="font-semibold">Connected</h3>
        <ul className="space-y-3">{withAccounts.map(card)}</ul>
      </section>}
      {groups.map((group) => <section key={group.category} aria-label={group.category} className="space-y-3">
        <h3 className="font-semibold">{group.category}</h3>
        <ul className="space-y-3">{group.apps.map(card)}</ul>
      </section>)}

      {strays.length > 0 && <section aria-labelledby="apps-other" className="space-y-2 rounded-lg border border-line p-4">
        <h3 id="apps-other" className="font-semibold">No supported agent actions</h3>
        <p className="text-xs text-muted">These accounts are for apps agents cannot use here. You can disconnect them.</p>
        <ul className="divide-y divide-line text-sm">{strays.map((account) => <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>{account.toolkit} · {account.alias ?? account.id} <span className="text-xs text-muted">· {statusLabel(account.status)}</span></span>
          <button type="button" className={BUTTON} disabled={busy !== null} aria-label={`Disconnect ${account.alias ?? account.id}`} onClick={() => void disconnect(account)}>Disconnect</button>
        </li>)}</ul>
      </section>}
    </>}

    {configured && <div className="flex flex-wrap gap-2 border-t border-line pt-4">
      {!replacing && <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setReplacing(true)}>Replace key</button>}
      {removingKey
        ? <span className="flex flex-wrap items-center gap-2 text-xs">Remove the key from this app? Connected accounts stay at Composio; disconnect them first to revoke them.
            <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void removeKey()}>Remove key</button>
            <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setRemovingKey(false)}>Keep</button></span>
        : <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setRemovingKey(true)}>Remove key</button>}
    </div>}
  </div>;
}
