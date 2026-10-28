// Settings is a few pages with a list on the side, so no one page holds every control.

export type SettingsPage = { href: string; label: string; summary: string };

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { href: "/settings/", label: "General", summary: "Appearance, updates and the setup guide." },
  { href: "/settings/engines/", label: "Engines", summary: "Claude Code, Codex and the other engines, their paths and limits." },
  { href: "/settings/approvals/", label: "Approvals", summary: "Commands you always allow and what was decided." },
  { href: "/settings/account/", label: "Account & privacy", summary: "Your account, devices, history export and permissions." },
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
