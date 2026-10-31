import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Centered "nothing here yet" or "can't do that here" block: icon, one line of what, one of why/next.
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  // Tighter type and spacing for narrow lists such as the sidebar.
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-1 px-3 py-3" : "gap-2 px-6 py-10", className)}>
      {icon ? <div aria-hidden="true" className="mb-1 text-faint">{icon}</div> : null}
      <h2 className={cn("font-semibold text-ink", compact ? "text-sm" : "text-base")}>{title}</h2>
      {description ? <p className={cn("max-w-sm text-muted", compact ? "text-xs" : "text-sm")}>{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
