import { cn } from "@/lib/cn";

// ok below 80%, near from 80%, full at 100%. Never shows 100% unless truly full; a sliver shows once anything is used.
export function meterBand(fraction: number): "ok" | "near" | "full" {
  return fraction >= 1 ? "full" : fraction >= 0.8 ? "near" : "ok";
}

const FILL = { ok: "bg-accent", near: "bg-warning", full: "bg-danger" } as const;

export function Progress({ value, max = 1, label, valueText, className }: { value: number; max?: number; label: string; valueText?: string; className?: string }) {
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const shown = fraction >= 1 ? 100 : Math.min(99, Math.max(fraction > 0 ? 2 : 0, Math.round(fraction * 100)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={shown}
      aria-valuetext={valueText}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-inset", className)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-(--dur-base)", FILL[meterBand(fraction)])} style={{ width: `${shown}%` }} />
    </div>
  );
}
