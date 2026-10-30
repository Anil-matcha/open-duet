// A conversation's workspace files on the phone: the shapes the server returns and what the screens do with them.
// Plain TypeScript with no React Native imports, so it is easy to test.

export type FileEntry = {
  name: string;
  /** Relative to the workspace root, with forward slashes. */
  path: string;
  /** `dir`, `file`, or `hidden` (a secret file: listed, never read). */
  type: string;
  bytes: number | null;
};

export type Folder = { path: string; entries: FileEntry[]; truncated: boolean };

export type Preview = {
  path: string;
  name: string;
  bytes: number;
  mime: string;
  /** `text`, `image` or `binary`; anything else is treated as binary. */
  kind: string;
  /** The start of a text file; null otherwise. */
  text: string | null;
  truncated: boolean;
};

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads the server's folder listing tolerantly: unknown fields are ignored, malformed entries dropped. */
export function readFolder(raw: unknown): Folder {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { path?: unknown; entries?: unknown; truncated?: unknown };
  const entries = Array.isArray(body.entries)
    ? body.entries
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && isString((entry as FileEntry).name) && isString((entry as FileEntry).path))
        .map((entry) => ({
          name: entry.name as string,
          path: entry.path as string,
          type: isString(entry.type) ? entry.type : 'file',
          bytes: isNumber(entry.bytes) ? entry.bytes : null,
        }))
    : [];
  return { path: isString(body.path) ? body.path : '', entries, truncated: body.truncated === true };
}

export function readPreview(raw: unknown): Preview {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const path = isString(body.path) ? body.path : '';
  return {
    path,
    name: isString(body.name) ? body.name : baseName(path),
    bytes: isNumber(body.bytes) ? body.bytes : 0,
    mime: isString(body.mime) ? body.mime : 'application/octet-stream',
    kind: isString(body.kind) ? body.kind : 'binary',
    text: isString(body.text) ? body.text : null,
    truncated: body.truncated === true,
  };
}

export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

/** The folder a path is in; the workspace root is the empty string. */
export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** What a folder screen is called: its own name, or "Files" at the root. */
export const folderTitle = (path: string): string => baseName(path) || 'Files';

/** 1.4 MB, 12 KB, 300 B. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** A name safe to save under in the phone's cache. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'file';
}
