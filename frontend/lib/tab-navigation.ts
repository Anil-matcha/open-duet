/** Returns the tab that should receive focus for a horizontal tab-list key. */
export function tabTargetForKey<T extends string>(
  tabs: readonly T[],
  current: T,
  key: string,
): T | null {
  const index = tabs.indexOf(current);
  if (index < 0 || tabs.length === 0) return null;
  if (key === "Home") return tabs[0] ?? null;
  if (key === "End") return tabs[tabs.length - 1] ?? null;
  if (key === "ArrowRight") return tabs[(index + 1) % tabs.length] ?? null;
  if (key === "ArrowLeft") return tabs[(index - 1 + tabs.length) % tabs.length] ?? null;
  return null;
}
