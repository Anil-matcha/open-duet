"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Component, Fragment, useCallback, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SETTINGS_NAV_GROUPS, activeSettingsPage } from "@/lib/settings-nav";
import { SETTINGS_REGISTRY, settingsControlMatches, shouldExpandBeforeSettingsFocus } from "@/lib/settings-registry";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { SettingsSearch } from "./SettingsSearch";

function matchingControl(scope: HTMLElement, hint: string): HTMLElement | null {
  const needle = hint.toLocaleLowerCase().trim();
  const controls = [...scope.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [role="tab"], [role="radio"]',
  )];
  const labels = [...scope.querySelectorAll<HTMLLabelElement>("label[for]")];
  const matching = controls.find((control) => {
    const associatedLabel = labels.find((label) => label.htmlFor === control.id)?.textContent ?? "";
    const nestedLabel = control.closest("label")?.textContent ?? "";
    const radioGroupLabel = control.closest('[role="radiogroup"]')?.getAttribute("aria-label") ?? "";
    const text = [control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent, associatedLabel, nestedLabel, radioGroupLabel]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return settingsControlMatches(needle, text);
  });
  if (matching) return matching;
  const landmark = [...scope.querySelectorAll<HTMLElement>("h1, h2, h3, h4, section[aria-label]")]
    .find((candidate) => `${candidate.getAttribute("aria-label") ?? ""} ${candidate.textContent ?? ""}`.toLocaleLowerCase().includes(needle));
  return landmark ?? (needle.includes("api key") ? scope.querySelector<HTMLElement>('input[type="password"]:not(:disabled)') : null);
}

function firstControl(scope: HTMLElement): HTMLElement | null {
  return scope.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [role="tab"], [role="radio"]',
  );
}

class SettingsErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Settings panel error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="space-y-4">
          <Banner tone="danger">
            {this.state.error?.message || "An unexpected error occurred in this settings panel."}
          </Banner>
          <Button variant="secondary" onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// The frame every Settings page shares: a list of the pages beside (above, on a
// phone) the page that is open.
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const active = activeSettingsPage(pathname);
  const pendingFocus = useRef<(() => void) | null>(null);
  const focusAnchor = useCallback((anchorId: string) => {
    pendingFocus.current?.();
    const entry = SETTINGS_REGISTRY.find((item) => item.anchorId === anchorId);
    let observer: MutationObserver | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const stop = () => {
      stopped = true;
      observer?.disconnect();
      if (timeout !== null) clearTimeout(timeout);
    };
    const attempt = (allowFallback = false) => {
      if (stopped) return false;
      const anchor = document.getElementById(anchorId);
      if (!anchor) return false;
      const root = anchor.closest<HTMLElement>("[data-setting-root]") ?? anchor.parentElement ?? anchor;
      const row = [...root.querySelectorAll<HTMLElement>("[data-setting-id]")]
        .find((candidate) => candidate.dataset.settingId === anchorId);
      row?.closest<HTMLDetailsElement>("details:not([open])")?.setAttribute("open", "");
      const targetSection = row
        ?? (anchor.matches("[data-setting-container]") ? anchor : anchor.closest<HTMLElement>("[data-setting-container]"))
        ?? (anchor.classList.contains("sr-only") ? root : anchor);
      const control = entry?.focusLabel
        ? matchingControl(targetSection, entry.focusLabel)
        : firstControl(targetSection);
      const expander = [...root.querySelectorAll<HTMLElement>("[data-setting-expand-for]")]
        .find((candidate) => candidate.dataset.settingExpandFor?.split(/\s+/).includes(anchorId));
      if (expander && shouldExpandBeforeSettingsFocus(!!row || !!control, expander.getAttribute("aria-expanded"))) {
        expander.click();
        return false;
      }
      if (entry?.focusLabel && !control && !allowFallback) return false;
      const focusTarget = control ?? targetSection;
      targetSection.scrollIntoView({ block: "start" });
      if (!focusTarget.hasAttribute("tabindex") && !focusTarget.matches("input, select, textarea, button, a[href], [tabindex]")) {
        focusTarget.tabIndex = -1;
      }
      focusTarget.focus({ preventScroll: true });
      if (focusTarget.getAttribute("role") === "tab") focusTarget.click();
      stop();
      return true;
    };

    if (attempt()) return;
    observer = new MutationObserver(() => { attempt(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    timeout = setTimeout(() => { attempt(true); stop(); }, 5000);
    pendingFocus.current = stop;
  }, []);

  useEffect(() => {
    const focusHash = () => {
      const anchorId = window.location.hash.slice(1);
      if (anchorId && SETTINGS_REGISTRY.some((entry) => entry.anchorId === anchorId)) focusAnchor(anchorId);
    };
    const onSettingsAnchor = (event: Event) => {
      const anchorId = (event as CustomEvent<unknown>).detail;
      if (typeof anchorId === "string" && SETTINGS_REGISTRY.some((entry) => entry.anchorId === anchorId)) focusAnchor(anchorId);
    };
    focusHash();
    window.addEventListener("hashchange", focusHash);
    window.addEventListener("settings:anchor", onSettingsAnchor);
    return () => {
      window.removeEventListener("hashchange", focusHash);
      window.removeEventListener("settings:anchor", onSettingsAnchor);
      pendingFocus.current?.();
      pendingFocus.current = null;
    };
  }, [focusAnchor, pathname]);

  return (
    <div className="min-h-dvh">
      <header className="flex h-12 items-center gap-4 border-b border-line px-4">
        <Link href="/chat/" className="text-sm text-muted hover:underline">
          ← Chat
        </Link>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="mx-auto max-w-4xl px-5 pt-4">
        <SettingsSearch />
      </div>
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:flex-row">
        <nav aria-label="Settings" className="md:w-52 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <Fragment key={group.label}>
                <li aria-hidden="true" className="hidden shrink-0 px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-muted first:pt-0 md:block">
                  {group.label}
                </li>
                {group.items.map((item) => (
                  <li key={item.href} className="shrink-0">
                    <Link
                      href={item.href}
                      aria-current={item.pageId === active.id ? "page" : undefined}
                      className={cn(
                        "block rounded-field px-3 py-2 text-sm hover:bg-hover touch:py-3",
                        item.pageId === active.id ? "bg-hover font-medium text-ink" : "text-muted"
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </Fragment>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 space-y-6">
          <div>
            <h2 className="text-heading font-semibold">{active.label}</h2>
            <p className="mt-1.5 text-body text-muted">{active.summary}</p>
          </div>
          <SettingsErrorBoundary key={active.href}>{children}</SettingsErrorBoundary>
        </main>
      </div>
    </div>
  );
}
