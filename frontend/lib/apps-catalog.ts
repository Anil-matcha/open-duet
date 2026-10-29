// The Apps page: the plain logic for browsing Composio's catalog and connecting apps, kept
// apart from the component so it can be tested.
import type { ComposioAccount } from "./connected-apps.ts";

export type CatalogTool = { name: string; kind: "read" | "write"; description: string };
export type Connection = "managed" | "no_auth" | "custom_auth" | "unknown";
// curated: only its own tools. generic: the two generic tools, every call approved. unavailable: never for agents.
// unknown: an app with an account here that the loaded catalog does not list.
export type AgentActions = "curated" | "generic" | "unavailable" | "unknown";
export type CatalogApp = {
  app: string;
  name: string;
  description: string;
  categories: string[];
  icon: string | null;
  connection: Connection;
  agent_actions: AgentActions;
  curated_tools: CatalogTool[];
};
export type CatalogPage = {
  source: "composio" | "starter";
  complete: boolean;
  stale: boolean;
  error: string | null;
  total: number;
  next_cursor: string | null;
  categories: { name: string; count: number }[];
  apps: CatalogApp[];
};

export type AppFilter = { search: string; category: string | null; connectedOnly: boolean };
export const NO_FILTER: AppFilter = { search: "", category: null, connectedOnly: false };

const WAITING = new Set(["INITIATED", "INITIALIZING"]);
const FAILED = new Set(["FAILED", "EXPIRED"]);

export function filterActive(filter: AppFilter): boolean {
  return filter.search.trim() !== "" || filter.category !== null || filter.connectedOnly;
}

// What the server is asked: search and category narrow its pages; "Connected" is decided here, from the accounts.
export function pageQuery(filter: AppFilter): { search: string; category: string | null } {
  return { search: filter.search.trim(), category: filter.category };
}

// Pages are appended; an app that arrives twice is kept once.
export function mergeApps(current: CatalogApp[], next: CatalogApp[]): CatalogApp[] {
  const seen = new Set(current.map((app) => app.app));
  return [...current, ...next.filter((app) => !seen.has(app.app))];
}

export function toolCounts(app: CatalogApp): { read: number; write: number } {
  return {
    read: app.curated_tools.filter((tool) => tool.kind === "read").length,
    write: app.curated_tools.filter((tool) => tool.kind === "write").length,
  };
}

// One line about what an agent can do with the app. A generic action is never called a read.
export function agentActionsText(app: CatalogApp): string {
  if (app.agent_actions === "curated") {
    const { read, write } = toolCounts(app);
    return `Agents get ${read} read tool${read === 1 ? "" : "s"}${write ? ` and ${write} that change things (each asks you first)` : ""}.`;
  }
  if (app.agent_actions === "generic") return "Agents can look up its actions and run them, with your approval on every call.";
  if (app.agent_actions === "unavailable") return "Not available to agents: it would give them a shell, code or direct access to Composio.";
  return "Agent use is checked with Composio when you allow it for an agent.";
}

export function connectionNote(app: CatalogApp): string | null {
  if (app.connection === "custom_auth") return "Needs an auth config of your own in Composio, which this app does not set up.";
  if (app.connection === "no_auth") return "Needs no sign-in.";
  return null;
}

// Whether Connect is offered: not for an app agents can never use, and not for one that has no sign-in Composio supplies.
export function canConnect(app: CatalogApp): boolean {
  return app.agent_actions !== "unavailable" && app.connection !== "custom_auth";
}

export type CardState = "no_key" | "not_connected" | "pending" | "connected" | "failed";

// What one app's card shows. A working account wins over a pending or failed one beside it.
export function cardState(configured: boolean, mine: ComposioAccount[]): CardState {
  if (!configured) return "no_key";
  if (mine.some((account) => account.status === "ACTIVE")) return "connected";
  if (mine.some((account) => WAITING.has(account.status))) return "pending";
  if (mine.some((account) => FAILED.has(account.status))) return "failed";
  return "not_connected";
}

// Slugs of apps with a working account.
export function connectedSlugs(accounts: ComposioAccount[] | null): Set<string> {
  return new Set((accounts ?? []).filter((account) => account.status === "ACTIVE").map((account) => account.toolkit));
}

function matches(app: CatalogApp, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${app.name} ${app.app} ${app.description} ${app.categories.join(" ")}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// A card for an app that has an account here but is not in the pages loaded so far. The account is real whatever
// the catalog says, so the card is only there to manage it; it claims nothing about the app.
export function accountOnlyCard(slug: string, label: (slug: string) => string): CatalogApp {
  return { app: slug, name: label(slug), description: "", categories: [], icon: null, connection: "unknown", agent_actions: "unknown", curated_tools: [] };
}

// The Connected section is every app with an account, wherever the catalog paging has got to; the rest stay in
// their pages. The filter narrows both. A card appears once.
export function splitApps(apps: CatalogApp[], accounts: ComposioAccount[] | null, filter: AppFilter, label: (slug: string) => string): { connected: CatalogApp[]; others: CatalogApp[] } {
  const withAccounts = new Set((accounts ?? []).map((account) => account.toolkit));
  const loaded = new Set(apps.map((app) => app.app));
  const missing = [...withAccounts].filter((slug) => !loaded.has(slug)).sort().map((slug) => accountOnlyCard(slug, label));
  const fits = (app: CatalogApp) => (filter.category === null || app.categories.includes(filter.category)) && matches(app, filter.search);
  const connected = [...apps.filter((app) => withAccounts.has(app.app)), ...missing].filter(fits);
  return { connected, others: filter.connectedOnly ? [] : apps.filter((app) => !withAccounts.has(app.app)) };
}

export function groupByCategory(apps: CatalogApp[]): { category: string; apps: CatalogApp[] }[] {
  const groups = new Map<string, CatalogApp[]>();
  for (const app of apps) {
    const key = app.categories[0] ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return [...groups].map(([category, items]) => ({ category, apps: items }));
}

// What to tell the owner about where the list came from and how far to trust it. Null when nothing needs saying.
export function sourceNotice(page: CatalogPage, configured: boolean): { tone: "info" | "warning"; text: string } | null {
  if (page.source === "starter") {
    if (page.error === "key_rejected" || page.error === "permission_denied") return { tone: "warning", text: "Composio did not accept your key, so this is only the starter list. Replace the key below." };
    if (page.error) return { tone: "warning", text: "Could not reach Composio, so this is only the starter list. Try again in a moment." };
    return { tone: "info", text: configured ? "This is only the starter list." : "This is only a starter list of common apps. Add your Composio key below to browse all of Composio's apps." };
  }
  if (page.stale) return { tone: "warning", text: "Composio could not be reached; this is the last list it gave, which may be out of date." };
  if (!page.complete) return { tone: "info", text: "Composio's list was only partly loaded, so some apps may be missing. Search narrows it." };
  return null;
}
