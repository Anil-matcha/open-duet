export function Applies({ when }: { when: string }) {
  const normalized = when.trim().toLocaleLowerCase();
  const label = normalized === "immediately" || normalized === "now"
    ? "now"
    : normalized === "next_run" || normalized === "next turn"
      ? "next turn"
      : normalized === "restart" || normalized === "after restart"
        ? "after restart"
        : when;

  return <span className="rounded bg-inset px-2 py-1 text-xs text-muted">Applies: {label}</span>;
}
