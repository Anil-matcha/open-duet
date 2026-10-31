"use client";

import { ApprovalsTabs } from "@/components/approvals/ApprovalsPanel";
import { SettingsCard } from "./SettingsCard";

export function ApprovalsSettings() {
  return <SettingsCard title="Approvals" description="Commands you always allow, every decision about a tool call, and a read-only health scan of recent conversations."><ApprovalsTabs /></SettingsCard>;
}
