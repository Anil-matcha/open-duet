import Link from "next/link";
import { rowAction, summary } from "@/lib/needs-you";
import type { TranscriptItem } from "@/lib/transcript";

const SOURCE_STATUS: Record<string, string> = {
  available: "checked", quiet: "checked; no matching records",
  partial: "partial snapshot; more records or unreadable items may exist",
  failed: "check failed; contents unknown",
  unavailable: "unavailable; check the lead’s app access and connected account",
};

// The day's "Needs you" card, written by the server in the lead's chat. A newer
// revision replaces the older one (the transcript keeps only the latest).
export function NeedsYouCard({ item }: { item: Extract<TranscriptItem, { kind: "needs_you" }> }) {
  return (
    <section aria-label={item.title} className="space-y-2 rounded-field border border-line p-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{item.title}</h2>
        <span className="text-xs text-muted">{item.subtitle}</span>
      </header>
      {item.rows.length === 0 ? (
        <p className="text-xs text-muted">{item.emptyText}</p>
      ) : (
        <>
          <p className="sr-only">{summary(item.rows.length, item.more)}</p>
          <ul className="space-y-2">
            {item.rows.map((row) => {
              const action = rowAction(row);
              return (
                <li key={row.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words">{row.title}</p>
                    {row.detail && <p className="break-words text-xs text-muted">{row.detail}</p>}
                    {row.source && <p className="text-xs text-muted">{row.source}{row.at && <> · <time dateTime={row.at}>{new Date(row.at).toLocaleString(undefined, { timeZone: item.timeZone || "UTC" })}</time></>}</p>}
                  </div>
                  {action.href && (
                    <Link href={action.href} className="shrink-0 text-xs underline">
                      {action.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {item.more > 0 && <p className="text-xs text-muted">and {item.more} more</p>}
        </>
      )}
      {item.checkedAt && <p className="text-xs text-muted">Updated <time dateTime={item.checkedAt}>{new Date(item.checkedAt).toLocaleString(undefined, { timeZone: item.timeZone || "UTC" })}</time>{item.timeZone && ` (${item.timeZone})`}</p>}
      {item.providerCheckedAt && <p className="text-xs text-muted">Apps last checked <time dateTime={item.providerCheckedAt}>{new Date(item.providerCheckedAt).toLocaleString(undefined, { timeZone: item.timeZone || "UTC" })}</time> · Refreshes at most every 5 minutes.</p>}
      {(["calendar", "gmail"] as const).map((source) => item.sources?.[source] && <p key={source} className="text-xs text-muted">
        {source === "gmail" ? "Gmail inbox (last 7 days)" : "Primary calendar (today)"}: {SOURCE_STATUS[item.sources[source]] || "unknown"}.
      </p>)}
    </section>
  );
}
