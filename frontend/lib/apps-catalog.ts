// The Apps page: the plain logic for browsing the apps agents can use, kept
// apart from the component so it can be tested.
import type { ComposioAccount } from "./connected-apps.ts";

export type CatalogTool = { name: string; kind: "read" | "write"; description: string };
export type CatalogApp = { app: string; name: string; description: string; category: string; tools: CatalogTool[] };

export type AppFilter = { search: string; category: string | null; connectedOnly: boolean };
export const NO_FILTER: AppFilter = { search: "", category: null, connectedOnly: false };

const WAITING = new Set(["INITIATED", "INITIALIZING"]);
const FAILED = new Set(["FAILED", "EXPIRED"]);

export function categoriesOf(apps: CatalogApp[]): string[] {
  return [...new Set(apps.map((app) => app.category))].sort((a, b) => a.localeCompare(b));
}

export function filterActive(filter: AppFilter): boolean {
  return filter.search.trim() !== "" || filter.category !== null || filter.connectedOnly;
}

// Search matches the app's name, description and category; every word must match.
export function filterApps(apps: CatalogApp[], filter: AppFilter, connected: ReadonlySet<string>): CatalogApp[] {
  const words = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  return apps.filter((app) => {
    if (filter.category !== null && app.category !== filter.category) return false;
    if (filter.connectedOnly && !connected.has(app.app)) return false;
    const text = `${app.name} ${app.description} ${app.category}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function toolCounts(app: CatalogApp): { read: number; write: number } {
  return {
    read: app.tools.filter((tool) => tool.kind === "read").length,
    write: app.tools.filter((tool) => tool.kind === "write").length,
  };
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

// Accounts for an app that has no agent tools here (for example one connected
// before it was removed). They are shown apart, only to disconnect.
export function unsupportedAccounts(accounts: ComposioAccount[], apps: CatalogApp[]): ComposioAccount[] {
  const known = new Set(apps.map((app) => app.app));
  return accounts.filter((account) => !known.has(account.toolkit));
}
