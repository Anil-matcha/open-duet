"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

// "Are you sure?" for destructive or hard-to-undo actions. The confirm button names the action.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={loading}>{cancelLabel}</Button>
          <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
