"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  applyLanguage,
  LANGUAGE_KEY,
  parseLanguageChoice,
  resolveLocale,
  translate,
  writeLanguage,
  type LanguageChoice,
  type Locale,
  type MessageKey,
} from "@/lib/i18n";

const listeners = new Set<() => void>();
let listening = false;
let fallbackChoice: LanguageChoice | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function currentChoice(): LanguageChoice {
  if (fallbackChoice !== null) return fallbackChoice;
  if (typeof document === "undefined") return "en";
  try {
    return parseLanguageChoice(window.localStorage.getItem(LANGUAGE_KEY));
  } catch {
    return parseLanguageChoice(document.documentElement.dataset.languageChoice);
  }
}

function currentLocale(): Locale {
  if (typeof document === "undefined") return "en";
  return resolveLocale(currentChoice());
}

function refreshLanguage() {
  if (typeof document === "undefined") return;
  applyLanguage(document, currentChoice());
  notify();
}

function onStorage(event: StorageEvent) {
  if (event.key !== LANGUAGE_KEY && event.key !== null) return;
  fallbackChoice = null;
  refreshLanguage();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    listening = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listening && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      listening = false;
    }
  };
}

export function useLanguageChoice(): LanguageChoice {
  return useSyncExternalStore(subscribe, currentChoice, () => "en");
}

export function useT() {
  const locale = useSyncExternalStore(subscribe, currentLocale, (): Locale => "en");
  return useCallback(
    (key: MessageKey | string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  );
}

export function setLanguageChoice(choice: LanguageChoice): void {
  fallbackChoice = writeLanguage(() => window.localStorage, choice) ? null : choice;
  if (typeof document !== "undefined") {
    applyLanguage(document, choice);
    notify();
  }
}
