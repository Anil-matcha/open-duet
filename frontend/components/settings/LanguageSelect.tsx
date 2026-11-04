"use client";

import { Languages } from "lucide-react";
import { LANGUAGE_CHOICES, LANGUAGE_LABELS, LANGUAGE_TAGS } from "@/lib/i18n";
import { setLanguageChoice, useLanguageChoice, useT } from "@/lib/use-i18n";
import { Select } from "@/components/ui/Select";

export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const choice = useLanguageChoice();

  const options = LANGUAGE_CHOICES.map((language) => ({
    value: language,
    label: LANGUAGE_LABELS[language],
    lang: LANGUAGE_TAGS[language],
  }));

  if (compact) {
    return (
      <Select
        aria-label={t("language.label")}
        value={choice}
        onChange={(event) =>
          setLanguageChoice(event.target.value as (typeof LANGUAGE_CHOICES)[number])
        }
        title={t("language.label")}
        containerClassName="w-[4.25rem] sm:w-auto sm:min-w-28 shrink-0"
        triggerClassName="h-9 touch:h-10 px-2 sm:px-3 gap-1.5 justify-center sm:justify-start bg-raised hover:bg-hover border-line"
        menuClassName="min-w-44"
        chevronClassName="hidden sm:inline-block"
        leadingIcon={<Languages size={16} aria-hidden="true" />}
        triggerLabel={
          <>
            <span className="text-[11px] font-semibold uppercase sm:hidden">{choice}</span>
            <span className="hidden truncate text-xs font-medium sm:inline">
              {LANGUAGE_LABELS[choice]}
            </span>
          </>
        }
        options={options}
      />
    );
  }

  return (
    <Select
      aria-label={t("language.label")}
      value={choice}
      onChange={(event) =>
        setLanguageChoice(event.target.value as (typeof LANGUAGE_CHOICES)[number])
      }
      containerClassName="w-auto min-w-40 shrink-0"
      triggerClassName="h-9 min-w-40 text-sm"
      menuClassName="min-w-40"
      leadingIcon={<Languages size={16} aria-hidden="true" />}
      options={options}
    />
  );
}
