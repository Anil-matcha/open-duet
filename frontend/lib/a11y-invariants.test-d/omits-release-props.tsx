// NEGATIVE CONTROL — this file MUST fail `tsc`.
//
// It constructs a key-capturing canvas without the required release contract.
// The a11y invariant is that this cannot compile: a surface that forwards keys
// must declare escapeKeys + onEscape (see lib/a11y-invariants.ts). It lives in a
// `.test-d/` directory excluded from the main tsconfig so it never reaches the
// build; the control compiles it explicitly and expects a non-zero exit.
//
// Run: node_modules/.bin/tsc -p lib/a11y-invariants.test-d/tsconfig.json  (exit != 0)
import { TrappedCanvas } from "../../components/chat/TrappedCanvas";

export function BadSurface() {
  // `escapeKeys` and `onEscape` are both missing, and `escapeKeys` cannot be
  // defaulted because TrappedCanvasProps Omits them from the canvas base props.
  return <TrappedCanvas tabIndex={0} aria-label="traps the keyboard" />;
}
