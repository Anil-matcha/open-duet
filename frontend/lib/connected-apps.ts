// Connected apps (Composio): the parts of the Settings flow that are plain
// logic, kept apart from the component so they can be tested.

export type ComposioApp = { slug: string; label: string };
export type ComposioAccount = {
  id: string;
  toolkit: string;
  alias: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};
export type ComposioLink = { redirect_url: string; account_id: string; expires_in_seconds: number };

export const POLL_INTERVAL_MS = 3000;

const WAITING = new Set(["INITIATED", "INITIALIZING"]);
const FAILED = new Set(["FAILED", "EXPIRED"]);

export function statusLabel(status: string): string {
  if (status === "ACTIVE") return "Connected";
  if (WAITING.has(status)) return "Waiting for you to finish in your browser";
  if (status === "FAILED") return "Connection failed";
  if (status === "EXPIRED") return "Link expired";
  if (status === "INACTIVE") return "Inactive";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export type Outcome = "connected" | "waiting" | "failed" | "gone";

// What the account we are waiting for looks like in the latest listing.
export function outcomeFor(accounts: ComposioAccount[], accountId: string): Outcome {
  const found = accounts.find((account) => account.id === accountId);
  if (!found) return "gone";
  if (found.status === "ACTIVE") return "connected";
  if (FAILED.has(found.status)) return "failed";
  return "waiting";
}

// Only an https link on composio.dev is ever opened; the server checks too.
export function isComposioLink(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 4096 || /\s/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && url.port === ""
      && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

export type LinkBridge = { openComposioLink?: (url: string) => Promise<void> };
export type TabWindow = { opener: unknown; closed?: boolean; location: { href: string }; close(): void };
export type Opener = (url: string, target: string) => TabWindow | null;

export type ReservedPage = { navigate(url: string): Promise<void>; cancel(): void };

// A browser blocks a window opened after an await, so the tab is opened during
// the click and sent to the link once the server has made it. The desktop app
// has no tabs: its shell opens the link in the system browser.
export function reservePage(bridge: LinkBridge | undefined, open: Opener): ReservedPage {
  if (bridge?.openComposioLink) {
    const openLink = bridge.openComposioLink;
    return {
      navigate: async (url) => { if (!isComposioLink(url)) throw new Error("This connect link is not from Composio."); await openLink(url); },
      cancel: () => {},
    };
  }
  const tab = open("about:blank", "_blank");
  if (tab) tab.opener = null;
  return {
    navigate: async (url) => {
      if (!isComposioLink(url)) { tab?.close(); throw new Error("This connect link is not from Composio."); }
      if (!tab || tab.closed) throw new Error("Your browser blocked the new tab. Allow pop-ups for this page and try again.");
      tab.location.href = url;
    },
    cancel: () => { tab?.close(); },
  };
}

// Waiting stops at the link's life (a little over, so a late success is seen).
export function pollDeadline(expiresInSeconds: number, now: number): number {
  const seconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? Math.min(expiresInSeconds, 3600) : 600;
  return now + (seconds + 15) * 1000;
}

export function accountsOf(accounts: ComposioAccount[], toolkit: string): ComposioAccount[] {
  return accounts.filter((account) => account.toolkit === toolkit);
}

// The apps an agent can be allowed to use in this version, and the engine that can use them.
export const AGENT_APPS: { slug: string; label: string; read: string; write: string | null }[] = [
  {
    slug: "github", label: "GitHub",
    read: "Read your profile, repositories, issues, pull requests, commits and files, and search.",
    write: "Also create issues, comment, and close or reopen issues. You approve each change first.",
  },
  {
    slug: "gmail", label: "Gmail",
    read: "Search messages, read message threads, and see the connected account profile.",
    write: "Also create a plain-text draft reply in an existing thread. You approve each draft; it is never sent.",
  },
  {
    slug: "googlecalendar", label: "Google Calendar",
    read: "List calendars and search event summaries in a date window of up to 31 days.",
    write: null,
  },
];
export const APPS_ENGINE = "claude";

export type Level = "off" | "read" | "write";
export type Scopes = Record<string, string>;

export function levelOf(scopes: Scopes | null | undefined, slug: string): Level {
  const level = scopes?.[slug];
  return level === "read" || level === "write" ? level : "off";
}

// The scopes after setting one app's level. "off" removes it; the others are untouched.
export function withApp(scopes: Scopes | null | undefined, slug: string, level: Level): Scopes {
  const next: Scopes = { ...(scopes ?? {}) };
  if (level === "off") delete next[slug]; else next[slug] = level;
  return next;
}

// What to send when saving an agent: nothing for an engine that cannot use apps
// (this also clears them if the engine was changed), else the known levels or null.
export function scopesToSend(scopes: Scopes | null | undefined, provider: string): Scopes | null {
  if (provider !== APPS_ENGINE) return null;
  const known = Object.fromEntries(Object.entries(scopes ?? {}).filter(([slug, level]) => {
    const app = AGENT_APPS.find((candidate) => candidate.slug === slug);
    return Boolean(app && (level === "read" || (level === "write" && app.write)));
  }));
  return Object.keys(known).length ? known : null;
}
