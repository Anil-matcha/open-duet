"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SETTINGS_PAGES, activeSettingsPage } from "@/lib/settings-nav";

// The frame every Settings page shares: a list of the pages beside (above, on a
// phone) the page that is open.
export function SettingsShell({ children }: { children: ReactNode }) {
  const active = activeSettingsPage(usePathname() ?? "");
  return <div className="min-h-dvh">
    <header className="flex h-12 items-center gap-4 border-b border-line px-4"><Link href="/chat/" className="text-sm text-muted hover:underline">← Chat</Link><h1 className="text-sm font-semibold">Settings</h1></header>
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:flex-row">
      <nav aria-label="Settings" className="md:w-52 md:shrink-0">
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          {SETTINGS_PAGES.map((page) => <li key={page.href} className="shrink-0">
            <Link href={page.href} aria-current={page.href === active.href ? "page" : undefined}
              className={cn("block rounded-md px-3 py-2 text-sm hover:bg-hover", page.href === active.href ? "bg-hover font-medium" : "text-muted")}>{page.label}</Link>
          </li>)}
          <li className="shrink-0"><Link href="/apps/" className="block rounded-md px-3 py-2 text-sm text-muted hover:bg-hover">Apps ↗</Link></li>
        </ul>
      </nav>
      <main className="min-w-0 flex-1 space-y-6">
        <div><h2 className="text-xl font-semibold">{active.label}</h2><p className="mt-2 text-sm text-muted">{active.summary}</p></div>
        {children}
      </main>
    </div>
  </div>;
}
