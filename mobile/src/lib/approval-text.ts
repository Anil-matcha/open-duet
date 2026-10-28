// What an approval card shows: every input of the call, as the server will run it, so a person is
// never asked to allow something they cannot read. Pure: no React.

export type ApprovalField = { name: string; value: string };

/** A long value is previewed this far; the card offers the rest. */
export const PREVIEW_CHARS = 600;

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function approvalFields(input: Record<string, unknown>): ApprovalField[] {
  return Object.entries(input).map(([name, value]) => ({ name, value: format(value) }));
}

export function previewValue(value: string): { text: string; cut: boolean } {
  return value.length > PREVIEW_CHARS ? { text: value.slice(0, PREVIEW_CHARS), cut: true } : { text: value, cut: false };
}
