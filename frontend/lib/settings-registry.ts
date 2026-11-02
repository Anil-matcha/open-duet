import { SETTINGS_PAGES, type SettingsPageId } from "./settings-nav.ts";

export type SettingsRegistryEntry = {
  id: string;
  page: SettingsPageId;
  pageHref: string;
  section: string;
  title: string;
  keywords: readonly string[];
  anchorId: string;
  /** Visible label used to focus a particular control inside an async section. */
  focusLabel?: string;
  /** Tab to select when this section is opened from its anchor. */
  tabId?: string;
};

const pageHref = Object.fromEntries(SETTINGS_PAGES.map((page) => [page.id, page.href])) as Record<SettingsPageId, string>;

/** The searchable index for every settings section and control row. */
export const SETTINGS_REGISTRY = [
  { id: "general-appearance", page: "general", pageHref: pageHref.general, section: "Appearance", title: "Appearance", keywords: ["theme", "light", "dark", "system", "colour", "color"], anchorId: "setting-general-appearance", focusLabel: "Theme" },
  { id: "general-language", page: "general", pageHref: pageHref.general, section: "Language", title: "Language", keywords: ["locale", "english", "spanish", "translation", "regional"], anchorId: "setting-general-language", focusLabel: "Language" },
  { id: "general-updates", page: "general", pageHref: pageHref.general, section: "App updates", title: "Check for updates", keywords: ["version", "upgrade", "new version", "desktop"], anchorId: "setting-general-updates", focusLabel: "Check for updates" },
  { id: "general-setup", page: "general", pageHref: pageHref.general, section: "Getting started", title: "Setup guide", keywords: ["onboarding", "first agent", "engine choice", "getting started"], anchorId: "setting-general-setup", focusLabel: "Open setup guide" },
  { id: "general-apps", page: "general", pageHref: pageHref.general, section: "Connected apps", title: "Connected apps", keywords: ["integrations", "connections", "app access", "connected services"], anchorId: "setting-general-apps", focusLabel: "Open Apps" },

  { id: "profile-details", page: "profile", pageHref: pageHref.profile, section: "Profile", title: "Profile details", keywords: ["name", "avatar", "photo", "bio", "edit profile", "share"], anchorId: "setting-profile-details", focusLabel: "Edit profile" },
  { id: "profile-summary", page: "profile", pageHref: pageHref.profile, section: "Annual summary", title: "Annual summary", keywords: ["tokens", "peak day", "messages", "streak", "activity stats"], anchorId: "setting-profile-summary", focusLabel: "Annual summary" },
  { id: "profile-activity", page: "profile", pageHref: pageHref.profile, section: "Activity", title: "Activity on this computer", keywords: ["heatmap", "active days", "year", "usage"], anchorId: "setting-profile-activity", focusLabel: "Activity on this computer" },
  { id: "profile-insights", page: "profile", pageHref: pageHref.profile, section: "Insights", title: "Usage insights", keywords: ["provider", "busiest day", "estimated cost", "teammates", "model distribution"], anchorId: "setting-profile-insights", focusLabel: "Insights" },
  { id: "profile-teammates", page: "profile", pageHref: pageHref.profile, section: "Most active teammates", title: "Most active teammates", keywords: ["agents", "tokens", "usage"], anchorId: "setting-profile-teammates", focusLabel: "Most active teammates" },
  { id: "profile-models", page: "profile", pageHref: pageHref.profile, section: "Model distribution", title: "Model distribution", keywords: ["models", "provider", "tokens", "usage"], anchorId: "setting-profile-models", focusLabel: "Model Distribution" },
  { id: "profile-local-account", page: "profile", pageHref: pageHref.profile, section: "Connected account", title: "Local profile and data", keywords: ["sign out", "reset", "delete", "account", "conversations", "local data"], anchorId: "setting-profile-account", focusLabel: "Sign out" },

  { id: "engine-cli", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Claude executable", keywords: ["path", "cli", "binary", "claude code", "command line"], anchorId: "setting-engine-claude-executable", focusLabel: "Claude executable" },
  { id: "engine-workspace", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Workspace root", keywords: ["folder", "directory", "workspace", "new conversations"], anchorId: "setting-engine-workspace-root", focusLabel: "Workspace root" },
  { id: "engine-tools", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Allow local tools", keywords: ["permissions", "computer", "files", "commands", "tools"], anchorId: "setting-engine-local-tools", focusLabel: "Allow local tools" },
  { id: "engine-answer-timeout", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Answer timeout", keywords: ["seconds", "limits", "timeout", "response"], anchorId: "setting-engine-answer-timeout", focusLabel: "Answer timeout" },
  { id: "engine-approval-timeout", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Approval timeout", keywords: ["seconds", "limits", "timeout", "approval"], anchorId: "setting-engine-approval-timeout", focusLabel: "Approval timeout" },
  { id: "engine-output-limit", page: "engines", pageHref: pageHref.engines, section: "Claude Code", title: "Answer output limit", keywords: ["bytes", "limits", "output", "response"], anchorId: "setting-engine-output-limit", focusLabel: "Answer output limit" },
  { id: "engine-storage", page: "engines", pageHref: pageHref.engines, section: "Storage", title: "Storage locations", keywords: ["workspace", "paths", "folders", "managed", "desktop"], anchorId: "setting-engine-storage" },
  { id: "engine-connections", page: "engines", pageHref: pageHref.engines, section: "Engine connections", title: "Engine connections", keywords: ["providers", "models", "AI", "engine setup", "sign in"], anchorId: "setting-engine-connections" },
  { id: "engine-api-key", page: "engines", pageHref: pageHref.engines, section: "Engine connections", title: "API keys and credentials", keywords: ["api key", "secret", "token", "credential", "sign in", "provider key"], anchorId: "setting-engine-api-key", focusLabel: "api key" },
  { id: "engine-endpoint", page: "engines", pageHref: pageHref.engines, section: "Engine connections", title: "Engine address and model", keywords: ["base url", "endpoint", "service", "model", "custom model", "url"], anchorId: "setting-engine-endpoint", focusLabel: "model" },

  { id: "approvals-rules", page: "approvals", pageHref: pageHref.approvals, section: "Approvals", title: "Always allowed", keywords: ["rules", "commands", "permissions", "allowlist", "approvals"], anchorId: "setting-approvals-rules", focusLabel: "Always allowed", tabId: "rules" },
  { id: "approvals-decisions", page: "approvals", pageHref: pageHref.approvals, section: "Approvals", title: "Decisions", keywords: ["history", "approved", "denied", "tool calls", "approval log"], anchorId: "setting-approvals-decisions", focusLabel: "Decisions", tabId: "decisions" },
  { id: "approvals-health", page: "approvals", pageHref: pageHref.approvals, section: "Approvals", title: "Health scan", keywords: ["health", "scan", "conversations", "audit"], anchorId: "setting-approvals-health", focusLabel: "Health", tabId: "health" },

  { id: "account-app", page: "account", pageHref: pageHref.account, section: "App account", title: "App account", keywords: ["sign in", "sign out", "local profile", "reset", "delete account"], anchorId: "setting-account-app", focusLabel: "Sign out of app account" },
  { id: "account-reset", page: "account", pageHref: pageHref.account, section: "App account", title: "Reset local data", keywords: ["erase", "agents", "conversations", "settings", "provider keys", "reset profile"], anchorId: "setting-account-reset", focusLabel: "Reset this profile" },
  { id: "account-delete", page: "account", pageHref: pageHref.account, section: "App account", title: "Delete account", keywords: ["cloud account", "erase", "permanent", "delete my account"], anchorId: "setting-account-delete", focusLabel: "Delete my account" },
  { id: "account-devices", page: "account", pageHref: pageHref.account, section: "Devices", title: "Devices and pairing", keywords: ["phone", "tablet", "browser", "pair", "access", "device token"], anchorId: "setting-account-devices" },
  { id: "account-device-list", page: "account", pageHref: pageHref.account, section: "Devices", title: "Signed-in devices", keywords: ["sessions", "browsers", "revoke", "device tokens"], anchorId: "setting-account-device-list", focusLabel: "Revoke" },
  { id: "account-device-access", page: "account", pageHref: pageHref.account, section: "Devices", title: "Pairing access", keywords: ["chat only", "files", "full access", "scope", "permissions"], anchorId: "setting-account-device-access", focusLabel: "Access" },
  { id: "account-device-name", page: "account", pageHref: pageHref.account, section: "Devices", title: "Paired device name", keywords: ["name", "phone", "label", "pairing"], anchorId: "setting-account-device-name", focusLabel: "Name" },
  { id: "account-history", page: "account", pageHref: pageHref.account, section: "Your history", title: "Export history", keywords: ["download", "zip", "backup", "agents", "conversations", "data export"], anchorId: "setting-account-history", focusLabel: "Export my history" },
  { id: "account-permissions", page: "account", pageHref: pageHref.account, section: "Mac permissions", title: "Desktop permissions", keywords: ["accessibility", "screen recording", "native control", "mac permissions"], anchorId: "setting-account-permissions", focusLabel: "Open settings" },
  { id: "account-accessibility", page: "account", pageHref: pageHref.account, section: "Mac permissions", title: "Accessibility permission", keywords: ["accessibility", "native control", "open settings"], anchorId: "setting-account-accessibility", focusLabel: "Accessibility" },
  { id: "account-screen-recording", page: "account", pageHref: pageHref.account, section: "Mac permissions", title: "Screen Recording permission", keywords: ["screen recording", "native control", "open settings"], anchorId: "setting-account-screen-recording", focusLabel: "Screen Recording" },
] satisfies readonly SettingsRegistryEntry[];

export type RankedSetting = { entry: SettingsRegistryEntry; score: number };

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();

/** Return matching rows in relevance order, requiring every query word to match. */
export function rankSettings(query: string): RankedSetting[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const wholeTitleMatches = (entry: SettingsRegistryEntry) => normalize(entry.title) === normalized;
  const scored = SETTINGS_REGISTRY.flatMap((entry, order) => {
    const title = normalize(entry.title);
    const section = normalize(entry.section);
    const keywords = entry.keywords.map(normalize);
    const scoreForTerm = (term: string) => {
      if (title === term) return 120;
      if (title.startsWith(term)) return 90;
      if (title.includes(term)) return 70;
      if (keywords.some((keyword) => keyword === term)) return 55;
      if (keywords.some((keyword) => keyword.includes(term))) return 42;
      if (section.includes(term)) return 25;
      return 0;
    };
    const scores = terms.map(scoreForTerm);
    if (scores.some((score) => score === 0)) return [];
    const score = scores.reduce<number>((sum, part) => sum + part, 0) + (wholeTitleMatches(entry) ? 180 : 0) - order / 1000;
    return [{ entry, score }];
  });
  return scored.sort((a, b) => b.score - a.score);
}

export function settingsEntryHref(entry: SettingsRegistryEntry): string {
  return `${entry.pageHref}#${entry.anchorId}`;
}

export function settingsTabForAnchor(anchorId: string): string | null {
  return SETTINGS_REGISTRY.find((entry) => entry.anchorId === anchorId)?.tabId ?? null;
}

/** Match a setting against a control's own accessible name and associated label. */
export function settingsControlMatches(hint: string, accessibleName: string): boolean {
  const needle = normalize(hint);
  return !!needle && normalize(accessibleName).includes(needle);
}

export function shouldExpandBeforeSettingsFocus(hasTargetRow: boolean, ariaExpanded: string | null): boolean {
  return !hasTargetRow && ariaExpanded === "false";
}

export type SettingsSearchKeyAction = { type: "move"; active: number } | { type: "clear" } | { type: "select" };

export function settingsSearchKeyAction(key: string, active: number, resultCount: number): SettingsSearchKeyAction | null {
  if (key === "Escape") return { type: "clear" };
  if (key === "Enter") return { type: "select" };
  if (key === "Home") return { type: "move", active: 0 };
  if (key === "End") return { type: "move", active: Math.max(resultCount - 1, 0) };
  if (key === "ArrowDown") return { type: "move", active: resultCount ? (active + 1) % resultCount : 0 };
  if (key === "ArrowUp") return { type: "move", active: resultCount ? (active - 1 + resultCount) % resultCount : 0 };
  return null;
}
