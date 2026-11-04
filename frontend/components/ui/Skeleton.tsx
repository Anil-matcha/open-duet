import { cn } from "@/lib/cn";

// A placeholder block that pulses while content loads. Decorative: pair with a status line for screen readers.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-field bg-hover/70", className)} />;
}

// N stacked rows, the usual stand-in for a list that is loading.
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col gap-2", className)}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}
