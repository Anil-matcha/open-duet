"use client";

import { Button } from "@/components/ui/Button";
import { saveBarState } from "./save-bar-state";
import { SavedConfirmation } from "./SavedConfirmation";

export function SaveBar({
  dirty,
  saving,
  error,
  saved,
  canSave = true,
  onSave,
  onDiscard,
  saveLabel = "Save",
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
  canSave?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  const state = saveBarState({ dirty, saving, error, saved });
  if (state === "idle") return null;

  const status = state === "saving"
    ? "Saving…"
    : state === "error"
      ? error
        : state === "dirty"
          ? "Unsaved changes"
          : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-inset p-3" data-save-state={state}>
      {state === "saved" ? <SavedConfirmation visible /> : state === "error" ? <p role="alert" className="min-w-0 flex-1 text-xs text-danger">{status}</p> : <p className="min-w-0 flex-1 text-xs text-muted">{status}</p>}
      <Button type="button" variant="primary" disabled={!dirty || saving || !canSave} loading={saving} onClick={onSave}>
        {saving ? "Saving…" : saveLabel}
      </Button>
      <Button type="button" disabled={!dirty || saving} onClick={onDiscard}>Discard</Button>
    </div>
  );
}
