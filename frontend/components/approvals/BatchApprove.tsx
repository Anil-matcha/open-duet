"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { batchGate, runBatchApprove, type BatchCandidate, type BatchOutcome } from "@/lib/approvals";
import { BUTTON } from "./styles";

// Batch approve for pending approvals the owner has selected. It only offers a
// single "Approve N" when every selected request is explain-confirmed safe
// floor; anything else stays one by one (no rubber-stamping). Approving fans out
// one accept call per approval and reports per item.
export function BatchApprove({
  approvals,
  onApprove,
  onChanged,
}: {
  approvals: { id: string; tool: string; threadId: number }[];
  onApprove: (threadId: number, approvalId: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [floorClear, setFloorClear] = useState<Record<string, boolean | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<BatchOutcome[] | null>(null);

  // Resolve the floor verdict for each pending approval from the explain
  // endpoint. Until it answers, the item counts as not clear and cannot be
  // batched. A failed explain leaves it one by one.
  useEffect(() => {
    let cancelled = false;
    for (const item of approvals) {
      if (item.id in floorClear) continue;
      api
        .explainApproval(item.id)
        .then((payload) => { if (!cancelled) setFloorClear((prev) => ({ ...prev, [item.id]: payload.floor_verdict.clear })); })
        .catch(() => { if (!cancelled) setFloorClear((prev) => ({ ...prev, [item.id]: false })); });
    }
    return () => { cancelled = true; };
  }, [approvals, floorClear]);

  const chosen: BatchCandidate[] = approvals
    .filter((a) => selected[a.id])
    .map((a) => ({ id: a.id, tool: a.tool, floorClear: floorClear[a.id] ?? null }));
  const gate = batchGate(chosen);

  const run = useCallback(async () => {
    setBusy(true); setError(null); setOutcomes(null);
    const byId = new Map(approvals.map((a) => [a.id, a]));
    const result = await runBatchApprove(chosen, (id) => {
      const item = byId.get(id);
      if (!item) throw new Error("That request is no longer waiting.");
      return onApprove(item.threadId, id);
    });
    setOutcomes(result);
    if (result.some((o) => !o.ok)) setError("Some requests could not be approved; see the list.");
    setSelected({});
    setBusy(false);
    onChanged();
  }, [chosen, approvals, onApprove, onChanged]);

  if (approvals.length === 0) return null;

  return (
    <div className="space-y-2 rounded-field border border-line p-3 text-sm">
      <p className="text-xs font-medium">Waiting requests</p>
      <ul className="space-y-1">
        {approvals.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              aria-label={`Select ${a.tool} request`}
              checked={selected[a.id] === true}
              disabled={busy || floorClear[a.id] !== true}
              onChange={(e) => setSelected((prev) => ({ ...prev, [a.id]: e.target.checked }))}
            />
            <span className="font-mono">{a.tool}</span>
            {floorClear[a.id] !== true && <span className="text-muted">· needs its own decision</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button className={BUTTON} disabled={busy || !gate.enabled} onClick={() => void run()} title={gate.reason ?? undefined}>
          {busy ? "Approving…" : `Approve ${gate.count || ""}`.trim()}
        </button>
        {gate.reason && <span className="text-xs text-muted">{gate.reason}</span>}
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {outcomes && (
        <ul className="space-y-0.5">
          {outcomes.map((o) => (
            <li key={o.id} className={o.ok ? "text-xs text-muted" : "text-xs text-danger"}>
              <span className="font-mono">{o.id}</span>: {o.ok ? "approved" : o.error ?? "failed"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
