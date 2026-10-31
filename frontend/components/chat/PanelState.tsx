"use client";

import type { ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";

// The three states every panel shares, so loading, empty and failed look the same everywhere.
export function LoadingState({ rows = 3, className }: { rows?: number; className?: string }) {
  return <SkeletonList rows={rows} className={className} />;
}

// Plain-language failure with a way to try again.
export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <Banner tone="danger" className={className} action={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>
      {message}
    </Banner>
  );
}

// Nothing here yet: say what it is and offer the next step when there is one.
export function EmptyPanel({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return <EmptyState className="py-8" title={title} description={description} action={action} icon={icon} />;
}
