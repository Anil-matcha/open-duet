"use client";

import Link from "next/link";
import { AppUpdates } from "@/components/AppUpdates";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function GeneralSettings() {
  return <div className="space-y-6">
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-raised p-5">
      <div><h3 className="font-semibold">Appearance</h3><p className="mt-1 text-xs text-muted">Follows your system by default. Saved in this browser only.</p></div>
      <ThemeToggle />
    </section>
    <AppUpdates />
    <section className="space-y-2 rounded-lg border border-line p-5"><h3 className="font-semibold">Getting started</h3><p className="text-sm text-muted">Revisit engine choice, your first agent and the first-request guide.</p><Link className="text-sm underline" href="/onboarding/">Open setup guide</Link></section>
    <section className="space-y-2 rounded-lg border border-line p-5"><h3 className="font-semibold">Connected apps</h3><p className="text-sm text-muted">Connect GitHub, Gmail, Google Calendar and your Composio key on the Apps page.</p><Link className="text-sm underline" href="/apps/">Open Apps</Link></section>
  </div>;
}
