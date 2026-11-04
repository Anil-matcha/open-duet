export type SaveBarState = "idle" | "dirty" | "saving" | "error" | "saved";

export function saveBarState({
  dirty,
  saving,
  error,
  saved,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
}): SaveBarState {
  if (saving) return "saving";
  if (error) return "error";
  if (dirty) return "dirty";
  if (saved) return "saved";
  return "idle";
}
