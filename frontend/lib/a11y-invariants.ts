// Type-level accessibility invariants.
//
// The strongest a11y control in this codebase is already structural: IconButton
// removes `aria-label` from the underlying button props so an unlabelled icon
// button cannot be constructed (see components/ui/IconButton.tsx). This module
// generalises that pattern to keyboard capture: a surface that forwards keys to a
// remote machine must, at the type level, declare the keys that release control
// and the handler that performs the release. Omitting either — or passing an
// empty list — fails to compile, so the class of bug behind ISSUE-07 (a
// full-surface canvas that swallowed Tab and Escape) cannot be reintroduced.

/** The keys that hand control back, as a non-empty tuple: an empty array is a
 *  compile error, not a silently-trapping surface. */
export type ReleaseKeys = readonly [string, ...string[]];

/** The release contract a key-capturing surface must satisfy. Compose it into the
 *  surface's props with `Omit<…, "escapeKeys" | "onEscape">` (mirroring
 *  IconButton's label pattern) so a default cannot quietly satisfy it. */
export type TrappedSurfaceProps = {
  /** Keys that return control to the agent instead of going to the guest. Must
   *  be the same constant the runtime handler reads (single source of truth). */
  escapeKeys: ReleaseKeys;
  /** Called when one of `escapeKeys` is pressed. */
  onEscape: () => void;
};

/** The release chords this app ships. Kept in one place so the type-level
 *  `escapeKeys` and the runtime `isReleaseChord` read the same list. */
export const RELEASE_CHORD_KEYS = ["F6", "Escape"] as const satisfies ReleaseKeys;

/** Guard for call sites that build `escapeKeys` dynamically: a list that captures
 *  keys but names no release chord is rejected at runtime too, not only at the
 *  type level (belt and braces for a computed tuple). */
export function assertReleasesKeys(keys: readonly string[]): void {
  if (keys.length === 0) throw new Error("A key-capturing surface must declare at least one release key.");
}
