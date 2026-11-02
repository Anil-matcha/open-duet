// A field without a width, for one that sets its own (w-36, w-auto): adding a
// width class to FIELD does not work, because w-full can win in the stylesheet.
// Tokens only, so both themes follow the chosen palette.
export const FIELD_BOX =
  "rounded-field border border-line bg-inset px-3 py-1.5 text-sm text-ink placeholder:text-faint hover:border-faint focus-visible:border-accent touch:text-base";
export const FIELD = `w-full ${FIELD_BOX}`;
export const BUTTON =
  "cursor-pointer rounded-field border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 touch:min-h-11";
export const PRIMARY =
  "cursor-pointer rounded-field bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 touch:min-h-11";
