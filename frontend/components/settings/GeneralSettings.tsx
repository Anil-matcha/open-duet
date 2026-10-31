"use client";

import Link from "next/link";
import { AppUpdates } from "@/components/AppUpdates";
import { SettingsCard } from "./SettingsCard";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function GeneralSettings() {
  return <div className="space-y-6">
    <SettingsCard title="Appearance" description="Follows your system by default. Saved in this browser only." action={<ThemeToggle />} />
    <AppUpdates />
    <SettingsCard title="Getting started" description="Revisit engine choice, your first agent and the first-request guide." action={<Link className="text-sm text-accent hover:underline" href="/onboarding/">Open setup guide</Link>} />
    <SettingsCard title="Connected apps" description="Connect GitHub, Gmail, Google Calendar and your Composio key on the Apps page." action={<Link className="text-sm text-accent hover:underline" href="/apps/">Open Apps</Link>} />
  </div>;
}
