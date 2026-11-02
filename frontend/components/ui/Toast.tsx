"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type Tone = "success" | "info" | "danger";
type ToastItem = { id: number; tone: Tone; message: string };
type Show = (message: string, tone?: Tone) => void;

const ToastContext = createContext<Show>(() => {});

// Short confirmations ("Saved"). Errors that need action belong in a Banner, not here.
export const useToast = (): Show => useContext(ToastContext);

const ICONS = { success: CheckCircle2, info: Info, danger: XCircle } as const;
const COLOR = { success: "text-success", info: "text-accent", danger: "text-danger" } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((x) => x.id !== id)), []);
  const show = useCallback<Show>((message, tone = "success") => {
    const id = next.current++;
    setItems((all) => [...all.slice(-2), { id, tone, message }]);
    // Errors stay longer so they can be read.
    setTimeout(() => dismiss(id), tone === "danger" ? 8000 : 4000);
  }, [dismiss]);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {items.map((item) => {
          const Icon = ICONS[item.tone];
          return (
            <div key={item.id} className="pointer-events-auto flex w-full max-w-sm animate-pop-in items-center gap-2.5 rounded-card border border-line bg-raised px-3 py-2.5 text-sm text-ink shadow-lg">
              <Icon size={16} aria-hidden="true" className={cn("shrink-0", COLOR[item.tone])} />
              <span className="min-w-0 flex-1">{item.message}</span>
              <button type="button" onClick={() => dismiss(item.id)} aria-label={t("common.close")} className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:text-ink touch:size-10">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
