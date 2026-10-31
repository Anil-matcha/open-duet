import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex min-w-5 items-center justify-center rounded border border-line bg-inset px-1 font-mono text-[11px] text-muted", className)}>
      {children}
    </kbd>
  );
}
