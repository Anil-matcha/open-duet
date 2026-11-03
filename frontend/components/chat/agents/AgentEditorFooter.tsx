"use client";

import { Button } from "@/components/ui/Button";
import { saveBarState } from "@/components/settings/save-bar-state";

export function AgentEditorFooter({
  dirty,
  saving,
  error,
  canSave,
  saveLabel,
  cancelLabel,
  onCancel,
  form,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  canSave: boolean;
  saveLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  form: string;
}) {
  const state = saveBarState({ dirty, saving, error, saved: false });
  const status = state === "saving" ? "Saving…" : state === "error" ? error : state === "dirty" ? "Unsaved changes" : null;

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {state === "error" ? (
        <p role="alert" className="min-w-0 flex-1 text-xs text-danger">{status}</p>
      ) : (
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs text-muted">{status}</p>
      )}
      <Button
        type="submit"
        form={form}
        variant="primary"
        disabled={!canSave || saving}
        loading={saving}
        className="disabled:bg-inset disabled:text-muted disabled:opacity-100"
      >
        {saving ? "Saving…" : saveLabel}
      </Button>
      <Button type="button" disabled={saving} onClick={onCancel}>{cancelLabel}</Button>
    </div>
  );
}
