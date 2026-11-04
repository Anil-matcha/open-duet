"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/use-i18n";

// `label` is the text a screen reader hears; pass "" when the surrounding text already says it.
export function Spinner({ size = 16, label, className }: { size?: number; label?: string; className?: string }) {
  const t = useT();
  const text = label ?? t("common.loading");
  return (
    <span role={text ? "status" : undefined} className={cn("inline-flex", className)}>
      <Loader2 size={size} aria-hidden="true" className="animate-spin" />
      {text && <span className="sr-only">{text}</span>}
    </span>
  );
}
