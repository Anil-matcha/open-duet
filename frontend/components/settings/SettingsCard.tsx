import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// One look for every block on a Settings page: a raised card with a title, a line of help and
// optional action on the right. Rows inside it sit on hairlines.
export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={cn("rounded-card border border-line bg-raised p-5 shadow-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-title font-semibold">{title}</h3>
          {description ? <p className="mt-1 text-caption text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children ? <div className="mt-4 space-y-3">{children}</div> : null}
    </section>
  );
}
