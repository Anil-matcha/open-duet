import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

// A progress indicator for a short wizard. Ordered list, current step marked with aria-current="step";
// done and upcoming steps are named for screen readers, so state is never colour alone.
export function Stepper({ steps, current, label = "Setup progress", className }: { steps: readonly string[]; current: number; label?: string; className?: string }) {
  return (
    <ol aria-label={label} className={cn("flex items-start", className)}>
      {steps.map((name, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={name} aria-current={active ? "step" : undefined} className="flex min-w-0 flex-1 flex-col gap-1.5 last:flex-none">
            <div className="flex items-center">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-(--dur-base) motion-reduce:transition-none",
                  done && "border-accent bg-accent text-accent-fg",
                  active && "border-accent text-accent",
                  !done && !active && "border-line text-faint",
                )}
              >
                {done ? <Check size={13} /> : index + 1}
              </span>
              {index < steps.length - 1 ? (
                <span aria-hidden="true" className="mx-2 h-0.5 flex-1 overflow-hidden rounded-full bg-line">
                  <span className={cn("block h-full bg-accent transition-[width] duration-(--dur-base) ease-(--ease-ui) motion-reduce:transition-none", done ? "w-full" : "w-0")} />
                </span>
              ) : null}
            </div>
            <span className={cn("pr-2 text-xs", active ? "font-semibold text-ink" : "text-muted")}>
              {name}
              <span className="sr-only">{done ? " (done)" : active ? " (current step)" : " (not started)"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
