"use client";

import { Languages } from "lucide-react";
import { LANGUAGE_CHOICES, LANGUAGE_LABELS, LANGUAGE_TAGS } from "@/lib/i18n";
import { setLanguageChoice, useLanguageChoice, useT } from "@/lib/use-i18n";

export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const choice = useLanguageChoice();
  if (compact) {
    return (
      <div className="relative inline-flex h-9 w-[4.25rem] shrink-0 items-center justify-center gap-1.5 rounded-field border border-line bg-raised text-ink transition-colors hover:bg-hover focus-within:border-accent/60 touch:h-10 sm:w-auto sm:min-w-28 sm:justify-start sm:px-3" title={t("language.label")}>
        <Languages size={16} aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase sm:hidden">{choice}</span>
        <span className="hidden truncate text-xs font-medium sm:inline">{LANGUAGE_LABELS[choice]}</span>
        <select
          aria-label={t("language.label")}
          value={choice}
          onChange={(event) => setLanguageChoice(event.target.value as (typeof LANGUAGE_CHOICES)[number])}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {LANGUAGE_CHOICES.map((language) => (
            <option key={language} value={language} lang={LANGUAGE_TAGS[language]}>
              {LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <select
      aria-label={t("language.label")}
      value={choice}
      onChange={(event) => setLanguageChoice(event.target.value as (typeof LANGUAGE_CHOICES)[number])}
      className="h-9 min-w-40 cursor-pointer rounded-field border border-line bg-raised px-3 text-sm text-ink"
    >
      {LANGUAGE_CHOICES.map((language) => (
        <option key={language} value={language} lang={LANGUAGE_TAGS[language]}>
          {LANGUAGE_LABELS[language]}
        </option>
      ))}
    </select>
  );
}
