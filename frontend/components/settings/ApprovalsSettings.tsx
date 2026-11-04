"use client";

import { ApprovalsTabs } from "@/components/approvals/ApprovalsPanel";
import { SettingsCard } from "./SettingsCard";
import { Applies } from "./Applies";
import { useT } from "@/lib/use-i18n";

export function ApprovalsSettings() {
  const t = useT();
  return <div className="space-y-6" data-setting-root data-setting-container tabIndex={-1}>
    <span id="setting-approvals-rules" className="sr-only" />
    <span id="setting-approvals-decisions" className="sr-only" />
    <span id="setting-approvals-health" className="sr-only" />
    <SettingsCard title={t("approvals.title")} description={t("approvals.explanation")}>
      <Applies when="now" />
      <ApprovalsTabs />
    </SettingsCard>
  </div>;
}
