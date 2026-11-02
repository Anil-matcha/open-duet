"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { settingsTabForAnchor } from "@/lib/settings-registry";
import { tabTargetForKey } from "@/lib/tab-navigation";
import { useT } from "@/lib/use-i18n";
import { ApprovalRules } from "./ApprovalRules";
import { DecisionLog } from "./DecisionLog";
import { HealthScan } from "./HealthScan";

const TABS = ["rules", "decisions", "health"] as const;

type Tab = (typeof TABS)[number];

export function ApprovalsTabs({
  threadId = null,
  workspace = null,
}: {
  threadId?: number | null;
  workspace?: string | null;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("rules");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const syncTabToAnchor = () => {
      const nextTab = settingsTabForAnchor(window.location.hash.slice(1));
      setTab(TABS.some((candidate) => candidate === nextTab) ? nextTab as Tab : "rules");
    };
    syncTabToAnchor();
    window.addEventListener("hashchange", syncTabToAnchor);
    return () => window.removeEventListener("hashchange", syncTabToAnchor);
  }, []);

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).dataset.tabId as Tab | undefined;
    if (!current) return;
    const next = tabTargetForKey(TABS, current, event.key);
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[TABS.findIndex((candidate) => candidate === next)]?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label={t("header.approvals")} onKeyDown={onTabKeyDown} className="mb-4 flex gap-1 border-b border-line">
        {TABS.map((id, index) => (
          <button
            key={id}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`approvals-tab-${id}`}
            data-tab-id={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls="approvals-tabpanel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`-mb-px cursor-pointer border-b-2 px-3 py-1.5 text-xs font-medium ${
              tab === id
                ? "border-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t(id === "rules" ? "approvals.allowedTab" : id === "decisions" ? "approvals.decisionsTab" : "approvals.healthTab")}
          </button>
        ))}
      </div>
      <div id="approvals-tabpanel" role="tabpanel" aria-labelledby={`approvals-tab-${tab}`}>
        {tab === "rules" && <ApprovalRules workspace={workspace} threadId={threadId} />}
        {tab === "decisions" && <DecisionLog threadId={threadId} />}
        {tab === "health" && <HealthScan />}
      </div>
    </div>
  );
}

// The Chat page's dialog for approvals: saved rules, the decision log and the scan.
export function ApprovalsPanel({
  threadId,
  workspace,
  onClose,
}: {
  threadId: number | null;
  workspace: string | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={t("approvals.title")} size="wide">
      <ApprovalsTabs threadId={threadId} workspace={workspace} />
    </Dialog>
  );
}
