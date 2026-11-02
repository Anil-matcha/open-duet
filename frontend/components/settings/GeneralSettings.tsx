"use client";

import Link from "next/link";
import { AppUpdates } from "@/components/AppUpdates";
import { SettingsCard } from "./SettingsCard";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LanguageSettings } from "./LanguageSettings";
import { Applies } from "./Applies";
import { SavedConfirmation, useSavedConfirmation } from "./SavedConfirmation";

export function GeneralSettings() {
  const confirmation = useSavedConfirmation();
  return <div className="space-y-6">
    <div id="setting-general-appearance" data-setting-id="setting-general-appearance" data-setting-container tabIndex={-1}>
      <SettingsCard title="Appearance" description="Follows your system by default. Saved in this browser only." action={<ThemeToggle onChange={() => confirmation.showSaved("theme")} />}>
        <div className="flex items-center gap-3"><Applies when="now" /><SavedConfirmation visible={confirmation.saved.has("theme")} /></div>
      </SettingsCard>
    </div>
    <div id="setting-general-language" data-setting-id="setting-general-language" data-setting-container tabIndex={-1}>
      <div onChange={() => confirmation.showSaved("language")}>
        <LanguageSettings />
      </div>
      <div className="mt-3 flex items-center gap-3"><Applies when="now" /><SavedConfirmation visible={confirmation.saved.has("language")} /></div>
    </div>
    <div id="setting-general-updates" data-setting-id="setting-general-updates" data-setting-container tabIndex={-1}>
      <AppUpdates />
    </div>
    <div id="setting-general-setup" data-setting-id="setting-general-setup" data-setting-container tabIndex={-1}>
      <SettingsCard title="Getting started" description="Revisit engine choice, your first agent and the first-request guide." action={<Link className="text-sm text-accent hover:underline" href="/onboarding/">Open setup guide</Link>} />
    </div>
    <SettingsCard title="Find agent settings" description="Agents, skills, memory and routines live in the chat workspace. Connected apps are managed separately.">
      <ul className="divide-y divide-line">
        <li className="py-2 first:pt-0">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">Agents and per-agent approvals</Link>
          <p className="mt-1 text-xs text-muted">Create or edit an agent, including its approval mode.</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">Skills</Link>
          <p className="mt-1 text-xs text-muted">Choose an agent, then select Skills.</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">Memory</Link>
          <p className="mt-1 text-xs text-muted">Choose an agent, then select Notes to edit memory and upkeep.</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=routines">Routines</Link>
        </li>
        <li id="setting-general-apps" data-setting-id="setting-general-apps" className="py-2 last:pb-0">
          <span className="text-sm">Connected apps</span>{" "}<Link className="text-sm text-accent hover:underline" href="/apps/">Open Apps</Link>
        </li>
      </ul>
    </SettingsCard>
  </div>;
}
