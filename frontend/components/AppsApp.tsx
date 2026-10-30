"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ComposioStatus } from "@/lib/api";
import {
  NO_FILTER, agentActionsText, canConnect, cardState, connectionNote, filterActive, groupByCategory, mergeApps, pageQuery,
  sourceNotice, splitApps, toolCounts, type AppFilter, type CardState, type CatalogApp, type CatalogPage,
} from "@/lib/apps-catalog";
import {
  POLL_INTERVAL_MS, accountsOf, appLabel, outcomeFor, pollDeadline, reservePage, statusLabel,
  type ComposioAccount, type TabWindow,
} from "@/lib/connected-apps";
import { Badge } from "@/components/ui/Badge";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "block w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm disabled:opacity-50";
const CHIP = "cursor-pointer rounded-full border border-line px-3 py-1 text-sm hover:bg-hover";
const CHIP_ON = "cursor-pointer rounded-full border border-ink bg-ink px-3 py-1 text-sm text-surface";
const CHIPS_SHOWN = 10;

type Waiting = { accountId: string; toolkit: string; expiresIn: number };
// Pages of one search: tagged with what was asked, so "loading" is simply "the answer is not for this question yet".
type Loaded = { key: string; apps: CatalogApp[]; page: CatalogPage } | { key: string; error: string };

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

const STATE_BADGE: Record<CardState, { tone: "neutral" | "success" | "warning" | "danger"; label: string }> = {
  no_key: { tone: "neutral", label: "Needs your Composio key" },
  not_connected: { tone: "neutral", label: "Not connected" },
  pending: { tone: "warning", label: "Finish connecting" },
  connected: { tone: "success", label: "Connected" },
  failed: { tone: "danger", label: "Connection failed" },
};

// The Apps page: Composio's catalog of apps, connecting and disconnecting them, and the owner's
// Composio key. Agent access is granted separately in each eligible agent's settings.
export function AppsApp() {
  return <div className="min-h-dvh">
    <header className="flex h-12 items-center gap-4 border-b border-line px-4"><Link href="/chat/" className="text-sm text-muted hover:underline">← Chat</Link><h1 className="text-sm font-semibold">Apps</h1><Link href="/marketplace/" className="ml-auto text-sm underline">MCP Marketplace</Link></header>
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-8">
      <div>
        <h2 className="text-xl font-semibold">Apps</h2>
        <p className="mt-2 text-sm text-muted">Connect an app once, then choose which agents may use it under Agents → choose an agent → Connected apps. Connecting an app does not give any agent access. Agents can use an allowed app only in conversations you start.</p>
      </div>
      <AppsBrowser />
    </main>
  </div>;
}

function Icon({ app }: { app: CatalogApp }) {
  const [broken, setBroken] = useState(false);
  if (app.icon && !broken) {
    // A remote picture, from a Composio host only (the server drops any other address); it never carries the referrer.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={app.icon} alt="" width={36} height={36} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="size-9 shrink-0 rounded-md bg-inset object-contain" />;
  }
  return <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-inset text-sm font-semibold text-muted">{app.name.charAt(0).toUpperCase()}</span>;
}

function AppsBrowser() {
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState<AppFilter>(NO_FILTER);
  const [allCategories, setAllCategories] = useState(false);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [more, setMore] = useState<{ key: string; apps: CatalogApp[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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

  // Typing waits a moment before it asks the server.
  useEffect(() => {
    const timer = setTimeout(() => setFilter((previous) => previous.search === searchInput ? previous : { ...previous, search: searchInput }), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = pageQuery(filter);
  const key = JSON.stringify([query.search, query.category, tick]);
  useEffect(() => {
    let cancelled = false;
    api.getComposioCatalog({ search: query.search, category: query.category })
      .then((page) => { if (!cancelled) setLoaded({ key, apps: page.apps, page }); })
      .catch((err: unknown) => { if (!cancelled) setLoaded({ key, error: message(err, "Could not load the apps.") }); });
    return () => { cancelled = true; };
  }, [key, query.search, query.category]);

  const ready = loaded !== null && loaded.key === key;
  const first = ready && !("error" in loaded) ? loaded : null;
  const extra = more !== null && more.key === key ? more : null;
  const apps = useMemo(() => first ? mergeApps(first.apps, extra?.apps ?? []) : [], [first, extra]);
  const nextCursor = first ? (extra ? extra.next : first.page.next_cursor) : null;

  const loadMore = async () => {
    if (!first || !nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.getComposioCatalog({ search: query.search, category: query.category, cursor: nextCursor });
      setMore((previous) => ({ key, apps: mergeApps(previous?.key === key ? previous.apps : [], page.apps), next: page.next_cursor }));
    } catch (err) { setError(message(err, "Could not load more apps.")); }
    finally { setLoadingMore(false); }
  };

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
      setKeyDraft(""); setReplacing(false); setStatus(saved); setAccounts(null); setWaiting(null); setMore(null);
      setNotice("Key saved.");
      setTick((n) => n + 1);
      await loadAccounts();
    } catch (err) { setError(message(err, "Could not save the key.")); }
    finally { setBusy(null); }
  };

  const removeKey = async () => {
    setBusy("key"); setError(null); setNotice(null);
    try {
      await api.deleteComposioKey();
      setStatus((previous) => previous && { ...previous, configured: false });
      setAccounts(null); setWaiting(null); setRemovingKey(false); setMore(null);
      setNotice("Key removed from this app. Connected accounts were not revoked at Composio.");
      setTick((n) => n + 1);
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
  const { connected, others } = splitApps(apps, accounts, filter, appLabel);
  const groups = groupByCategory(others);
  const categories = first ? first.page.categories : [];
  const shownChips = allCategories ? categories : categories.slice(0, CHIPS_SHOWN);
  const shownCount = connected.length + others.length;
  const banner = first ? sourceNotice(first.page, configured) : null;

  const accountRow = (account: ComposioAccount) => <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
    <span>{account.alias ?? account.id} <span className="text-xs text-muted">· {statusLabel(account.status)}</span></span>
    {confirming === account.id
      ? <span className="flex items-center gap-2 text-xs">Disconnect this account?
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => void disconnect(account)}>{busy === `remove:${account.id}` ? "Working…" : "Disconnect"}</button>
          <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button></span>
      : <button type="button" className={BUTTON} disabled={busy !== null} aria-label={`Disconnect ${account.alias ?? account.id}`} onClick={() => setConfirming(account.id)}>Disconnect</button>}
  </li>;

  const details = (app: CatalogApp, detailsId: string) => <div id={detailsId} className="mt-3 space-y-3">
    {app.agent_actions === "curated" && <>
      <p className="text-xs text-muted">These are the only tools agents get for {app.name}. Write access also includes the reads. Every change asks you first on an approval card.</p>
      <ul className="divide-y divide-line text-sm">
        {app.curated_tools.map((tool) => <li key={tool.name} className="flex items-start justify-between gap-3 py-2">
          <span className="min-w-0 text-muted">{tool.description}</span>
          <Badge tone={tool.kind === "write" ? "warning" : "neutral"} className="shrink-0">{tool.kind === "write" ? "Write" : "Read"}</Badge>
        </li>)}
      </ul>
    </>}
    {app.agent_actions !== "curated" && app.agent_actions !== "unavailable" && <div className="space-y-2 text-xs text-muted">
      <p><Badge tone="warning">Approval required</Badge> No action of this app is treated as a read, whatever its name says.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>An agent with this app allowed can search for its actions. Search does not run anything and shows part of the list, not every action.</li>
        <li>To run one, the agent needs the Read and change level, and you approve every call on a card that shows the app, account, action and exact arguments.</li>
        <li>Plan mode and the Read level never run it. If Composio changes the action while a card waits, the call is cancelled.</li>
        <li>Some actions need extra permissions Composio&apos;s sign-in does not ask for; those fail with a message.</li>
      </ul>
    </div>}
    {app.agent_actions === "unavailable" && <p className="text-xs text-muted">{agentActionsText(app)}</p>}
    <p className="text-xs text-muted">Connecting {app.name} does not allow any agent to use it. Allow it for an agent in that agent&apos;s settings (Agents → the agent → Connected apps).</p>
  </div>;

  const card = (app: CatalogApp) => {
    const mine = mineOf(app.app);
    const state = cardState(configured, mine);
    const badge = STATE_BADGE[state];
    const connecting = waiting?.toolkit === app.app;
    const detailsId = `app-details-${app.app}`;
    const offered = canConnect(app);
    const note = connectionNote(app);
    const counts = app.agent_actions === "curated" ? toolCounts(app) : null;
    return <li key={app.app} className="space-y-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon app={app} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{app.name}</h4>{app.agent_actions !== "unavailable" && <Badge tone={badge.tone}>{badge.label}</Badge>}{counts && <Badge tone="accent">Own tools</Badge>}</div>
            {app.description && <p className="mt-1 text-sm text-muted">{app.description}</p>}
            <p className="mt-1 text-xs text-muted">{agentActionsText(app)}{note ? ` ${note}` : ""}</p>
          </div>
        </div>
        {offered && <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`name-${app.app}`}>Name for a new {app.name} account (optional)</label>
          <input id={`name-${app.app}`} className="w-36 rounded-md border border-line bg-transparent px-2 py-1 text-sm disabled:opacity-50" placeholder="Name (optional)" maxLength={40}
            value={names[app.app] ?? ""} disabled={busy !== null || waiting !== null || !configured} autoComplete="off"
            onChange={(event) => setNames((previous) => ({ ...previous, [app.app]: event.target.value }))} />
          <button type="button" className={BUTTON} title={configured ? undefined : "Save your Composio key first"}
            disabled={busy !== null || waiting !== null || !configured || accounts === null} onClick={() => void connect(app)}>
            {busy === `connect:${app.app}` ? "Opening…" : mine.length ? "Add another" : "Connect"}
          </button>
        </div>}
      </div>
      {connecting && <p role="status" className="text-xs text-muted">
        Finish connecting {app.name} in your browser. This page notices when you are done.{" "}
        <button type="button" className="underline" onClick={() => { setWaiting(null); setNotice("Stopped waiting. A pending connection can be removed below; nothing was revoked."); }}>Stop waiting</button>
      </p>}
      {mine.length > 0 && <ul className="divide-y divide-line text-sm">{mine.map(accountRow)}</ul>}
      <div>
        <button type="button" className="cursor-pointer text-sm underline" aria-expanded={open === app.app} aria-controls={detailsId}
          onClick={() => setOpen(open === app.app ? null : app.app)}>{open === app.app ? "Hide details" : "What agents can do"}</button>
        {open === app.app && details(app, detailsId)}
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
        {!configured && <p className="text-sm text-muted">Add your own Composio project key to browse all of Composio&apos;s apps and connect them. It is stored encrypted on this computer and never shown again.</p>}
        <label htmlFor="composio-key" className="sr-only">Composio project key</label>
        <input id="composio-key" type="password" className={FIELD} value={keyDraft} disabled={busy !== null} required minLength={11}
          onChange={(event) => setKeyDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder="ak_…" />
        <p className="text-xs text-muted">Create a project key in your Composio dashboard (it starts with <code>ak_</code>). The key is checked with Composio before it is saved. A scoped key needs Connected accounts: Read, Session management: Write, Session tool execution: Write, and Toolkits: Read to list apps and their actions. Add Connected accounts: Write to disconnect accounts. Composio fixes scopes when you create a key, so make a new key after changing them.</p>
        <div className="flex gap-2">
          <button type="submit" className={BUTTON} disabled={busy !== null || keyDraft.trim().length < 11}>{busy === "key" ? "Checking…" : "Save key"}</button>
          {replacing && <button type="button" className={BUTTON} disabled={busy !== null} onClick={() => { setReplacing(false); setKeyDraft(""); }}>Cancel</button>}
        </div>
      </form>
    </section>}

    <div className="space-y-3">
      <label htmlFor="apps-search" className="sr-only">Search apps</label>
      <input id="apps-search" type="search" className={FIELD} placeholder="Search apps" value={searchInput} autoComplete="off"
        onChange={(event) => setSearchInput(event.target.value)} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter apps">
        <button type="button" className={!filter.category && !filter.connectedOnly ? CHIP_ON : CHIP} aria-pressed={!filter.category && !filter.connectedOnly}
          onClick={() => { setFilter({ ...filter, category: null, connectedOnly: false }); setMore(null); }}>All</button>
        {configured && <button type="button" className={filter.connectedOnly ? CHIP_ON : CHIP} aria-pressed={filter.connectedOnly}
          onClick={() => setFilter({ ...filter, connectedOnly: !filter.connectedOnly })}>Connected</button>}
        {shownChips.map((category) => <button key={category.name} type="button" className={filter.category === category.name ? CHIP_ON : CHIP} aria-pressed={filter.category === category.name}
          onClick={() => { setFilter({ ...filter, category: filter.category === category.name ? null : category.name, connectedOnly: false }); setMore(null); }}>{category.name}</button>)}
        {categories.length > CHIPS_SHOWN && <button type="button" className={CHIP} aria-expanded={allCategories} onClick={() => setAllCategories(!allCategories)}>{allCategories ? "Fewer" : "More"}</button>}
      </div>
    </div>

    {loaded !== null && "error" in loaded && loaded.key === key && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/50 p-3 text-sm text-danger">
      <span>{loaded.error}</span><button type="button" className={BUTTON} onClick={() => setTick((n) => n + 1)}>Try again</button>
    </div>}
    {!ready && <p role="status" className="text-sm text-muted">Loading apps…</p>}
    {banner && <p role="status" className={`rounded-md border p-3 text-sm ${banner.tone === "warning" ? "border-warning/50" : "border-line text-muted"}`}>{banner.text}</p>}

    {first && <>
      {shownCount === 0 && <div className="rounded-md border border-line p-4 text-sm text-muted">
        {filterActive(filter) ? "No apps match." : "No apps are available."}
        {filterActive(filter) && <> <button type="button" className="underline" onClick={() => { setSearchInput(""); setFilter(NO_FILTER); setMore(null); }}>Reset filters</button></>}
      </div>}
      {configured && accounts === null && !error && <p role="status" className="text-sm text-muted">Loading your apps…</p>}

      {connected.length > 0 && <section aria-labelledby="apps-connected" className="space-y-3">
        <h3 id="apps-connected" className="font-semibold">Connected</h3>
        <ul className="space-y-3">{connected.map(card)}</ul>
      </section>}
      {groups.map((group) => <section key={group.category} aria-label={group.category} className="space-y-3">
        <h3 className="font-semibold">{group.category}</h3>
        <ul className="space-y-3">{group.apps.map(card)}</ul>
      </section>)}
      {nextCursor && !filter.connectedOnly && <div className="flex items-center gap-3">
        <button type="button" className={BUTTON} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Show more apps"}</button>
        <span className="text-xs text-muted">{first.page.total} apps match.</span>
      </div>}
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
