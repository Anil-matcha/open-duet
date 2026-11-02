// "just now", "5 min ago", "yesterday"… for a sidebar row. After a week the plain date reads
// better than a count. Pure and import-free so node tests can load it: it returns which message
// to show (keys in lib/i18n.ts) and the caller translates; `now` is passed in for the same reason.

export type RelativeTime =
  | { key: "time.now" | "time.yesterday" }
  | { key: "time.minutes" | "time.hours" | "time.days"; n: number }
  | { date: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function relativeTime(iso: string, now: number = Date.now()): RelativeTime | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diff = now - then;
  if (diff < 45_000) return { key: "time.now" }; // also covers a slightly-ahead clock
  if (diff < HOUR) return { key: "time.minutes", n: Math.max(1, Math.round(diff / MINUTE)) };
  // Calendar days, not 24-hour blocks: 23:00 last night is "yesterday" at 07:00.
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 0) return { key: "time.hours", n: Math.max(1, Math.floor(diff / HOUR)) };
  if (days === 1) return { key: "time.yesterday" };
  if (days <= 7) return { key: "time.days", n: days };
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return { date: date.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }) };
}
