import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "warning";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-line bg-raised text-ink hover:bg-hover",
  ghost: "text-ink hover:bg-hover",
  danger: "bg-danger text-accent-fg hover:opacity-90",
  // A cautionary action that grants something lasting (e.g. "Always allow"):
  // outlined in the warning colour so it cannot be mistaken for the safe
  // default next to it.
  warning: "border border-warning bg-warning/10 text-warning hover:bg-warning/20",
};

// Touch targets reach 44 px on coarse pointers (`touch:`), 32 or 36 px with a mouse.
const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] touch:h-11",
  md: "h-9 px-4 text-sm touch:h-11",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-field font-medium transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} label="" /> : icon}
      {children}
    </button>
  );
});
