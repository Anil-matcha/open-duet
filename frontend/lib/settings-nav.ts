// Settings is a few pages with a list on the side, so no one page holds every control.

export type SettingsPageId = "general" | "profile" | "engines" | "approvals" | "account";
export type SettingsPage = { id: SettingsPageId; href: string; label: string; summary: string };
export type SettingsNavItem = { href: string; label: string; pageId?: SettingsPageId };
export type SettingsNavGroup = { label: string; items: readonly SettingsNavItem[] };

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "general", href: "/settings/", label: "General", summary: "Appearance, updates and the setup guide." },
  { id: "profile", href: "/settings/profile/", label: "Profile", summary: "Your profile, annual activity stats, top models and account." },
  { id: "engines", href: "/settings/engines/", label: "Engines", summary: "Claude Code, Codex and the other engines, their paths and limits." },
  { id: "approvals", href: "/settings/approvals/", label: "Approvals", summary: "Commands you always allow and what was decided." },
  { id: "account", href: "/settings/account/", label: "Account & privacy", summary: "Your account, devices, history export and permissions." },
];

const settingsPage = (id: SettingsPageId): SettingsNavItem => {
  const page = SETTINGS_PAGES.find((item) => item.id === id)!;
  return { href: page.href, label: page.label, pageId: page.id };
};

/** The same routes as SETTINGS_PAGES, arranged for the Settings navigation. */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  { label: "You", items: [settingsPage("general"), settingsPage("profile"), settingsPage("account")] },
  { label: "AI", items: [settingsPage("engines"), { href: "/apps/", label: "Apps ↗" }] },
  { label: "Safety", items: [settingsPage("approvals")] },
];

// Where to send someone who needs to sign in to an engine or fix its setup.
export const ENGINE_SETTINGS = "/settings/engines/";

const trimmed = (path: string) => path.replace(/\/+$/, "");

// The page whose entry is current. A path under a base path (/app/settings/engines) counts too.
export function activeSettingsPage(pathname: string): SettingsPage {
  const path = trimmed(pathname);
  const found = SETTINGS_PAGES.slice(1).find((page) => path.endsWith(trimmed(page.href)));
  return found ?? SETTINGS_PAGES[0];
}

// Setup comes first for a new owner, except on the pages that finish it: the guide and every Settings page.
export function isSetupPage(pathname: string): boolean {
  return /(^|\/)(onboarding|settings)(\/|$)/.test(pathname);
}
