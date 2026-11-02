"use client";

import { ApprovalsTabs } from "@/components/approvals/ApprovalsPanel";
import { SettingsCard } from "./SettingsCard";
import { Applies } from "./Applies";

export function ApprovalsSettings() {
  return <div className="space-y-6" data-setting-root data-setting-container tabIndex={-1}>
    <span id="setting-approvals-rules" className="sr-only" />
    <span id="setting-approvals-decisions" className="sr-only" />
    <span id="setting-approvals-health" className="sr-only" />
    <SettingsCard title="Approvals" description="Commands you always allow, every decision about a tool call, and a read-only health scan of recent conversations.">
      <Applies when="now" />
      <ApprovalsTabs />
    </SettingsCard>
  </div>;
}
