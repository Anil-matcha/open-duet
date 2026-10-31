import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; description?: ReactNode };

// Native inputs keep keyboard, form and screen-reader behaviour for free; the label is the whole hit area.
export const Checkbox = forwardRef<HTMLInputElement, Props>(function Checkbox({ label, description, className, ...rest }, ref) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 touch:min-h-11", className)}>
      <input ref={ref} type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-(--accent)" {...rest} />
      <span className="min-w-0">
        {label}
        {description ? <span className="block text-xs text-muted">{description}</span> : null}
      </span>
    </label>
  );
});

// A checkbox drawn as an on/off switch (role="switch").
export const Switch = forwardRef<HTMLInputElement, Props>(function Switch({ label, description, className, ...rest }, ref) {
  return (
    <label className={cn("flex cursor-pointer items-start justify-between gap-4 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 touch:min-h-11", className)}>
      <span className="min-w-0">
        {label}
        {description ? <span className="block text-xs text-muted">{description}</span> : null}
      </span>
      <input ref={ref} type="checkbox" role="switch" className="peer sr-only" {...rest} />
      <span
        aria-hidden="true"
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-hover transition-colors duration-(--dur-fast) peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-raised after:shadow-sm after:transition-transform after:duration-(--dur-fast) peer-checked:after:translate-x-4"
      />
    </label>
  );
});
