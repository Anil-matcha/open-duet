"use client";

import { LANGUAGE_CHOICES, LANGUAGE_LABELS, LANGUAGE_TAGS } from "@/lib/i18n";
import { setLanguageChoice, useLanguageChoice, useT } from "@/lib/use-i18n";

export function LanguageSelect() {
  const t = useT();
  const choice = useLanguageChoice();
  return (
    <select
      aria-label={t("language.label")}
      value={choice}
      onChange={(event) => setLanguageChoice(event.target.value as (typeof LANGUAGE_CHOICES)[number])}
      className="h-9 min-w-40 cursor-pointer rounded-field border border-line bg-raised px-3 text-sm text-ink"
    >
      {LANGUAGE_CHOICES.map((language) => (
        <option key={language} value={language} lang={language === "system" ? undefined : LANGUAGE_TAGS[language]}>
          {language === "system" ? t("language.system") : LANGUAGE_LABELS[language]}
        </option>
      ))}
    </select>
  );
}
