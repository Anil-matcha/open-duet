"use client";

import Link from "next/link";
import { AppUpdates } from "@/components/AppUpdates";
import { SettingsCard } from "./SettingsCard";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LanguageSettings } from "./LanguageSettings";
import { Applies } from "./Applies";
import { SavedConfirmation, useSavedConfirmation } from "./SavedConfirmation";
import { useT } from "@/lib/use-i18n";

export function GeneralSettings() {
  const t = useT();
  const confirmation = useSavedConfirmation();
  return <div className="space-y-6">
    <div id="setting-general-appearance" data-setting-id="setting-general-appearance" data-setting-container tabIndex={-1}>
      <SettingsCard title={t("appSettings.general.appearance")} description={t("appSettings.general.appearanceHelp")} action={<ThemeToggle onChange={() => confirmation.showSaved("theme")} />}>
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
      <SettingsCard title={t("appSettings.general.gettingStarted")} description={t("appSettings.general.gettingStartedHelp")} action={<Link className="text-sm text-accent hover:underline" href="/onboarding/">{t("appSettings.general.openSetup")}</Link>} />
    </div>
    <SettingsCard title={t("appSettings.general.agentSettings")} description={t("appSettings.general.agentSettingsHelp")}>
      <ul className="divide-y divide-line">
        <li className="py-2 first:pt-0">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">{t("appSettings.general.agentsApprovals")}</Link>
          <p className="mt-1 text-xs text-muted">{t("appSettings.general.agentsApprovalsHelp")}</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">{t("appSettings.general.skills")}</Link>
          <p className="mt-1 text-xs text-muted">{t("appSettings.general.skillsHelp")}</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=agents">{t("appSettings.general.memory")}</Link>
          <p className="mt-1 text-xs text-muted">{t("appSettings.general.memoryHelp")}</p>
        </li>
        <li className="py-2">
          <Link className="text-sm text-accent hover:underline" href="/chat/?view=routines">{t("appSettings.general.routines")}</Link>
        </li>
        <li id="setting-general-apps" data-setting-id="setting-general-apps" className="py-2 last:pb-0">
          <span className="text-sm">{t("appSettings.general.connectedApps")}</span>{" "}<Link className="text-sm text-accent hover:underline" href="/apps/">{t("appSettings.general.openApps")}</Link>
        </li>
      </ul>
    </SettingsCard>
  </div>;
}
