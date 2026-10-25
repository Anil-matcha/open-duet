"use client";

import type { TrappedSurfaceProps } from "@/lib/a11y-invariants";

// A canvas that captures keys must be constructed through this component: the
// release contract (escapeKeys + onEscape) is REQUIRED, and the plain canvas
// props cannot supply a default for it — `Omit<…, "escapeKeys" | "onEscape">`
// keeps those names out of the base type, mirroring IconButton's aria-label
// pattern. Dropping either prop from a call site is a compile error; the
// type-only control lives in lib/a11y-invariants.test-d/.
export type TrappedCanvasProps = Omit<React.ComponentPropsWithoutRef<"canvas">, "escapeKeys" | "onEscape"> &
  TrappedSurfaceProps & { ref?: React.Ref<HTMLCanvasElement> };

export function TrappedCanvas(props: TrappedCanvasProps) {
  // The declared keys are surfaced as data-* so the runtime parity test can read
  // what the surface claims to release on; forwarding itself stays with the
  // caller's onKeyDown.
  const { escapeKeys, onEscape, ...canvasProps } = props;
  void onEscape;
  return <canvas data-escape-keys={escapeKeys.join(",")} {...canvasProps} />;
}
