"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MarketplaceAgent, MarketplaceCatalog, MarketplaceConnection, MarketplaceListing, MarketplaceSection, MarketplaceTool } from "@/lib/marketplace";

const BUTTON = "cursor-pointer rounded-md border border-line px-3 py-2 text-sm hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "block w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The marketplace request failed.";

export function MarketplaceApp() {
  const [catalog, setCatalog] = useState<MarketplaceCatalog | null>(null);
  const [connections, setConnections] = useState<MarketplaceConnection[]>([]);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [tools, setTools] = useState<Record<string, MarketplaceTool[]>>({});
  const [selectedAgent, setSelectedAgent] = useState<Record<string, number | "">>({});
  const [selectedTools, setSelectedTools] = useState<Record<string, string[]>>({});
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextCatalog, nextConnections, nextAgents] = await Promise.all([
      api.getMarketplaceCatalog(), api.listMarketplaceConnections(), api.listAgents(),
    ]);
    setCatalog(nextCatalog);
    setConnections(nextConnections);
    setAgents(nextAgents.filter((agent) => agent.archived_at === null).map(({ id, name }) => ({ id, name })));
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.getMarketplaceCatalog(), api.listMarketplaceConnections(), api.listAgents()])
      .then(([nextCatalog, nextConnections, nextAgents]) => {
        if (!live) return;
        setCatalog(nextCatalog); setConnections(nextConnections);
        setAgents(nextAgents.filter((agent) => agent.archived_at === null).map(({ id, name }) => ({ id, name })));
      })
      .catch((reason: unknown) => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, []);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  };

  const forgetConnectionTools = (connectionId: string) => {
    setTools((old) => { const copy = { ...old }; delete copy[connectionId]; return copy; });
    setSelectedAgent((old) => { const copy = { ...old }; delete copy[connectionId]; return copy; });
    setSelectedTools((old) => Object.fromEntries(
      Object.entries(old).filter(([key]) => !key.startsWith(`${connectionId}:`)),
    ));
  };

  const install = (section: MarketplaceSection, listing: MarketplaceListing) => run(`install:${listing.slug}`, async () => {
    const existing = connections.find((item) => item.slug === listing.slug);
    await api.installMarketplaceListing(section, listing.slug, listing.manifest_digest);
    if (existing && existing.manifest_digest !== listing.manifest_digest) forgetConnectionTools(existing.id);
    setNotice(existing
      ? existing.manifest_digest === listing.manifest_digest
        ? `${listing.name} is now shown under ${section === "tested" ? "Tested by Open Dots" : "Community"}. Its pinned manifest, credential, and grants are unchanged.`
        : `${listing.name} updated. The old credential and grants were cleared; connect again, discover tools, and grant them to agents.`
      : `${listing.name} installed. Connect its credential separately, then discover tools and choose exact per-agent grants.`);
    await refresh();
  });

  const discover = (connection: MarketplaceConnection) => run(`discover:${connection.id}`, async () => {
    const found = await api.discoverMarketplaceTools(connection.id);
    setTools((old) => ({ ...old, [connection.id]: found }));
    const currentAgent = selectedAgent[connection.id];
    if (currentAgent) {
      const grants = await api.getMarketplaceAgentGrants(connection.id, currentAgent);
      setSelectedTools((old) => ({ ...old, [`${connection.id}:${currentAgent}`]: grants.tool_names }));
    }
    setNotice(`Discovered ${found.length} tools for ${connection.name}.`);
  });

  const loadGrants = async (connectionId: string, agentId: number) => {
    setSelectedAgent((old) => ({ ...old, [connectionId]: agentId }));
    try {
      const result = await api.getMarketplaceAgentGrants(connectionId, agentId);
      setSelectedTools((old) => ({ ...old, [`${connectionId}:${agentId}`]: result.tool_names }));
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const listingCard = (section: MarketplaceSection, listing: MarketplaceListing, connection?: MarketplaceConnection) => {
    connection = connection ?? connections.find((item) => item.slug === listing.slug && item.section === section);
    const installedElsewhere = !connection ? connections.find((item) => item.slug === listing.slug) : undefined;
    const currentTools = connection ? tools[connection.id] : undefined;
    const agentId = connection ? selectedAgent[connection.id] : "";
    const grantKey = connection && agentId !== "" ? `${connection.id}:${agentId}` : "";
    const grants = grantKey ? selectedTools[grantKey] ?? [] : [];
    return <article key={`${section}:${listing.slug}`} className="space-y-4 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h3 className="font-semibold">{listing.name}</h3><p className="mt-1 text-sm text-muted">{listing.summary}</p></div>
        <span className="rounded-full border border-line px-2 py-1 text-xs">{section === "tested" ? "Tested by Open Dots" : "Community"}</span>
      </div>
      <p className="text-xs text-muted">Version {listing.version} · {listing.publisher} · {listing.license}</p>
      <dl className="grid gap-2 rounded-md bg-inset p-3 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="font-medium">Remote endpoint</dt><dd className="break-all"><code>{listing.endpoint}</code></dd>
        <dt className="font-medium">Authentication</dt><dd>{listing.auth_mode === "bearer_token" ? "Bearer token" : "None"}</dd>
        <dt className="font-medium">Setup instructions</dt><dd className="whitespace-pre-wrap">{listing.setup_instructions}</dd>
        <dt className="font-medium">Test instructions</dt><dd className="whitespace-pre-wrap">{listing.test_instructions}</dd>
        <dt className="font-medium">Manifest digest</dt><dd className="break-all"><code>{listing.manifest_digest}</code></dd>
      </dl>
      {listing.evidence && <p className="text-xs text-muted">Tested {listing.evidence.tested_on} · <a className="underline" href={listing.evidence.evidence_url} target="_blank" rel="noreferrer">Evidence</a></p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><a className="underline" href={listing.source_repo} target="_blank" rel="noreferrer">Source</a><a className="underline" href={listing.privacy_url} target="_blank" rel="noreferrer">Privacy</a><a className="underline" href={listing.terms_url} target="_blank" rel="noreferrer">Terms</a></div>
      {!connection ? <div className="space-y-2">
        {installedElsewhere && <p className="text-xs text-muted">Already installed under {installedElsewhere.section === "tested" ? "Tested by Open Dots" : "Community"} at version {installedElsewhere.manifest.version}.</p>}
        <button className={BUTTON} disabled={busy !== null} onClick={() => void install(section, listing)}>{busy === `install:${listing.slug}` ? "Installing…" : installedElsewhere?.manifest_digest === listing.manifest_digest ? `Show under ${section === "tested" ? "Tested" : "Community"}` : installedElsewhere ? `Update to version ${listing.version}` : "Install"}</button>
      </div> : <div className="space-y-4 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">Installed · pinned to version {connection.manifest.version}</span>
          <button className={BUTTON} disabled={busy !== null} onClick={() => void run(`disconnect:${connection.id}`, async () => { await api.disconnectMarketplaceListing(connection.id); forgetConnectionTools(connection.id); setNotice(`${listing.name} disconnected.`); await refresh(); })}>Disconnect</button>
          <button className={BUTTON} disabled={busy !== null || (connection.manifest.auth_mode === "bearer_token" && !connection.credential_configured)} onClick={() => void discover(connection)}>{busy === `discover:${connection.id}` ? "Discovering…" : "Discover tools"}</button>
        </div>
        <dl className="grid gap-2 rounded-md bg-inset p-3 text-xs sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium">Active installed endpoint</dt><dd className="break-all"><code>{connection.manifest.endpoint}</code></dd>
          <dt className="font-medium">Active authentication</dt><dd>{connection.manifest.auth_mode === "bearer_token" ? "Bearer token" : "None"}</dd>
          <dt className="font-medium">Pinned catalog section</dt><dd>{connection.section === "tested" ? "Tested by Open Dots" : "Community"}</dd>
        </dl>
        {connection.manifest_digest !== listing.manifest_digest && <div className="space-y-2 rounded-md border border-line p-3 text-sm">
          <p>A newer listing is available. This installation continues using its pinned manifest until you update it.</p>
          <p className="break-all text-xs">Proposed endpoint: <code>{listing.endpoint}</code> · Authentication: {listing.auth_mode === "bearer_token" ? "Bearer token" : "None"}</p>
          <p className="text-xs text-muted">Updating replaces the endpoint and clears the saved credential and all agent tool grants. You will need to connect and grant tools again.</p>
          <button className={BUTTON} disabled={busy !== null} onClick={() => void install(section, listing)}>Update to version {listing.version}</button>
        </div>}
        <p className="break-all text-xs text-muted">Installed manifest: <code>{connection.manifest_digest}</code></p>
        {connection.manifest.auth_mode === "bearer_token" && <div className="space-y-2 rounded-md border border-line p-3">
          <p className="text-xs text-muted">This token is sent by the local backend to the active installed endpoint above for tool discovery and calls. It is not sent to the agent.</p>
          <label className="block space-y-1 text-sm">{connection.credential_configured ? "Replace stored bearer token" : "Set bearer token"}
            <input className={FIELD} type="password" autoComplete="new-password" value={tokens[listing.slug] ?? ""} onChange={(event) => setTokens((old) => ({ ...old, [listing.slug]: event.target.value }))} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className={BUTTON} disabled={busy !== null || !tokens[listing.slug]?.trim()} onClick={() => void run(`credential:${connection.id}`, async () => {
              await api.saveMarketplaceCredential(connection.id, tokens[listing.slug].trim());
              setTokens((old) => ({ ...old, [listing.slug]: "" })); forgetConnectionTools(connection.id); await refresh(); setNotice("Bearer token saved. Discover tools again, then review and grant them to an agent.");
            })}>Save token</button>
            {connection.credential_configured && <button className={BUTTON} disabled={busy !== null} onClick={() => void run(`remove-credential:${connection.id}`, async () => {
              await api.removeMarketplaceCredential(connection.id);
              forgetConnectionTools(connection.id); await refresh(); setNotice("Stored bearer token removed; agent grants were cleared.");
            })}>Remove stored token</button>}
          </div>
        </div>}
        {currentTools && <div className="space-y-3">
          <p className="text-sm font-medium">Exact per-agent tool grants</p>
          <p className="text-xs text-muted">Only checked tools are available to the selected agent. Every tool call requires your approval, with the tool and arguments shown before it runs.</p>
          {agents.length === 0 ? <p className="text-sm text-muted">Create an agent before granting tools.</p> : <>
            <select className={FIELD} value={agentId} onChange={(event) => { const value = event.target.value; if (value) void loadGrants(connection.id, Number(value)); }}>
              <option value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            {agentId !== "" && <>
              <ul className="space-y-2">{currentTools.map((tool) => <li key={tool.name}>
                <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={grants.includes(tool.name)} onChange={(event) => setSelectedTools((old) => ({ ...old, [grantKey]: event.target.checked ? [...grants, tool.name] : grants.filter((name) => name !== tool.name) }))} />
                  <span><span className="font-medium">{tool.name}</span><span className="block text-xs text-muted">{tool.description}</span></span></label>
              </li>)}</ul>
              <button className={BUTTON} disabled={busy !== null} onClick={() => void run(`grants:${grantKey}`, async () => {
                const exactTools = currentTools.filter((tool) => grants.includes(tool.name)).map(({ name, schema_digest }) => ({ name, schema_digest }));
                await api.saveMarketplaceAgentGrants(connection.id, Number(agentId), exactTools);
                setNotice("Exact tool grants saved.");
              })}>{busy === `grants:${grantKey}` ? "Saving…" : "Save grants"}</button>
            </>}
          </>}
        </div>}
      </div>}
    </article>;
  };

  return <div className="min-h-dvh">
    <header className="flex h-12 items-center gap-4 border-b border-line px-4"><Link href="/apps/" className="text-sm text-muted hover:underline">← Apps</Link><h1 className="text-sm font-semibold">MCP Marketplace</h1></header>
    <main className="mx-auto max-w-3xl space-y-8 px-5 py-8">
      <div><h2 className="text-xl font-semibold">MCP Marketplace</h2><p className="mt-2 text-sm text-muted">Install remote MCP services, then grant specific tools to each agent. Every call asks for your approval before it runs.</p></div>
      {error && <p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm text-muted">{notice}</p>}
      {!catalog ? <p className="text-sm text-muted">Loading marketplace…</p> : ([
        ["Tested by Open Dots", "tested", catalog.tested], ["Community", "community", catalog.community],
      ] as const).map(([heading, section, listings]) => <section key={section} className="space-y-3">
        <h2 className="text-lg font-semibold">{heading}</h2>
        {listings.map((listing) => listingCard(section, listing))}
        {connections.filter((connection) => connection.section === section && !Object.values(catalog).some((items) => items.some((listing) => listing.slug === connection.slug)))
          .map((connection) => <div key={`withdrawn:${connection.id}`}><p className="mb-2 text-xs text-muted">This listing is no longer in the current catalog. You can still manage or disconnect the installed copy.</p>{listingCard(section, connection.manifest, connection)}</div>)}
        {!listings.length && !connections.some((connection) => connection.section === section) && <p className="text-sm text-muted">No listings yet.</p>}
      </section>)}
    </main>
  </div>;
}
