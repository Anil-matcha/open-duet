import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { showsUnreadDot, type RowStatus } from "@/lib/sidebar";

// A row's state as a dot with a screen-reader label; never colour alone: waiting carries a "!"
// and the label is also the tooltip.
export function StatusDot({ status, unread = false, className }: { status: RowStatus; unread?: boolean; className?: string }) {
  if (status === null) return null;
  const label = t(`status.${status}`);
  // Unread beside a louder state: a second, small accent dot with its own label.
  if (showsUnreadDot(status, unread)) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        <StatusDot status={status} className={className} />
        <span role="status" aria-label={t("status.unread")} title={t("status.unread")} className="inline-block size-2 rounded-full bg-accent" />
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-warning text-[11px] font-black leading-none text-app", className)}
      >
        <span aria-hidden="true">!</span>
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        status === "working" ? "animate-pulse bg-success" : status === "unread" ? "bg-accent" : "bg-faint",
        className,
      )}
    />
  );
}
