"use client";

import { useT } from "@/lib/use-i18n";
import { SettingsCard } from "./SettingsCard";
import { LanguageSelect } from "./LanguageSelect";

export function LanguageSettings() {
  const t = useT();
  return (
    <SettingsCard
      title={t("language.title")}
      description={t("language.description")}
      action={<LanguageSelect />}
    />
  );
}
