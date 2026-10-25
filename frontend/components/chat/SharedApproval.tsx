"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type ExplainPayload } from "@/lib/api";
import { explainView, type ExplainView } from "@/lib/approvals";
import type { SharedApproval as Approval } from "@/lib/collaboration";
import { ApprovalCard } from "./items";

export function SharedApproval({ approval, onChanged }: { approval: Approval; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The explain projection: fetched once when the card renders. A failure
  // degrades to the legacy view with a visible banner (never blocks the answer),
  // and is not retried in a loop.
  const [explain, setExplain] = useState<ExplainView>({ state: "loading" });
  const answer = async (decision: "allow" | "deny") => {
    setBusy(true); setError(null);
    try { await api.answerThreadApproval(approval.thread_id, approval.id, decision); onChanged(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not answer this approval."); onChanged(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (approval.status !== "pending") return;
    let cancelled = false;
    api
      .explainApproval(approval.id)
      .then((payload: ExplainPayload) => { if (!cancelled) setExplain(explainView(payload)); })
      .catch(() => { if (!cancelled) setExplain(explainView(null, { failed: true })); });
    return () => { cancelled = true; };
  }, [approval.id, approval.status]);
  return <ApprovalCard item={{ kind: "approval", key: approval.id, turnId: approval.turn_id, approvalId: approval.id, tool: approval.tool, approvalKind: approval.kind ?? "other", summary: approval.summary ?? approval.tool, input: approval.input, status: approval.status, resolvedBy: "", ruleId: null }} answering={busy} error={error} onAnswer={(decision) => void answer(decision)} explain={explain} />;
}
