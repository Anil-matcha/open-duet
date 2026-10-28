"use client";

import { ApprovalsTabs } from "@/components/approvals/ApprovalsPanel";

export function ApprovalsSettings() {
  return <section className="rounded-lg border border-line p-5"><h3 className="mb-1 font-semibold">Approvals</h3><p className="mb-4 text-xs text-muted">Commands you always allow, every decision about a tool call, and a read-only health scan of recent conversations.</p><ApprovalsTabs /></section>;
}
