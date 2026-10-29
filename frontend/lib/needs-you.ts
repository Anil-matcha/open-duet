export type NeedsYouRow = {
  kind: "signed_out" | "out_of_credit" | "usage_limit" | "approval" | "routine" | "repeated_failure" | "question" | "due" | "routine_completed" | "calendar_event" | "gmail_message";
  key: string;
  title: string;
  detail: string | null;
  thread_id: number | null;
  at?: string | null;
  source?: string;
  source_id?: string | null;
  source_url?: string | null;
  source_timestamp?: string | null;
  source_record?: Record<string, unknown> | null;
  routine_id?: number | null;
  work_item_id?: number | null;
};

// What the one action on a row says. Every kind has exactly one next step.
const ACTIONS: Record<NeedsYouRow["kind"], string> = {
  signed_out: "Open settings",
  out_of_credit: "Open settings",
  usage_limit: "See usage",
  approval: "Review",
  routine: "Open the run",
  repeated_failure: "Look into it",
  question: "Answer",
  due: "Review task",
  routine_completed: "View runs",
  calendar_event: "Open event",
  gmail_message: "Open message",
};

export function rowAction(row: NeedsYouRow): { label: string; href: string | null } {
  const label = ACTIONS[row.kind] ?? "Open";
  if (row.source_url) {
    try {
      const url = new URL(row.source_url);
      if (url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && ["mail.google.com", "calendar.google.com", "www.google.com"].includes(url.hostname)) return { label, href: url.href };
    } catch { /* Invalid source links have no action. */ }
  }
  if (row.thread_id !== null) return { label, href: `/chat?thread=${row.thread_id}` };
  if (row.routine_id) return { label, href: `/chat?view=routines&routine=${row.routine_id}` };
  if (row.work_item_id) return { label, href: `/chat?view=planner&task=${row.work_item_id}` };
  if (row.kind === "usage_limit") return { label, href: "/chat?panel=usage" };
  if (row.kind === "signed_out" || row.kind === "out_of_credit") return { label, href: "/settings/engines/" };
  return { label, href: null };
}

export function summary(rows: number, more: number): string {
  const total = rows + more;
  return total === 0 ? "Nothing needs you right now." : `${total} thing${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} you`;
}
