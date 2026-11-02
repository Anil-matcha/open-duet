import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: { box: "border-accent/30 bg-accent/10", Icon: Info },
  success: { box: "border-success/30 bg-success/10", Icon: CheckCircle2 },
  warning: { box: "border-warning/30 bg-warning/10", Icon: AlertTriangle },
  danger: { box: "border-danger/30 bg-danger/10", Icon: XCircle },
};

// An inline notice. Danger and warning announce themselves (role=alert); the rest are polite status.
export function Banner({
  tone = "info",
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const { box, Icon } = TONES[tone];
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-field border px-3 py-2.5 text-sm text-ink", box, className)}>
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn("text-muted", title && "mt-0.5")}>{children}</div> : null}
        {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label={t("common.close")} className="-mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-field text-muted hover:bg-hover hover:text-ink touch:size-10">
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
