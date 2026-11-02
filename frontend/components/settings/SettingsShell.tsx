"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SETTINGS_PAGES, activeSettingsPage } from "@/lib/settings-nav";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";

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
  const active = activeSettingsPage(usePathname() ?? "");
  return (
    <div className="min-h-dvh">
      <header className="flex h-12 items-center gap-4 border-b border-line px-4">
        <Link href="/chat/" className="text-sm text-muted hover:underline">
          ← Chat
        </Link>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:flex-row">
        <nav aria-label="Settings" className="md:w-52 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SETTINGS_PAGES.map((page) => (
              <li key={page.href} className="shrink-0">
                <Link
                  href={page.href}
                  aria-current={page.href === active.href ? "page" : undefined}
                  className={cn(
                    "block rounded-field px-3 py-2 text-sm hover:bg-hover touch:py-3",
                    page.href === active.href ? "bg-hover font-medium text-ink" : "text-muted"
                  )}
                >
                  {page.label}
                </Link>
              </li>
            ))}
            <li className="shrink-0">
              <Link
                href="/apps/"
                className="block rounded-field px-3 py-2 text-sm text-muted hover:bg-hover touch:py-3"
              >
                Apps ↗
              </Link>
            </li>
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
