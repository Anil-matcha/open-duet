// Files and photos attached to a message. The server accepts PNG, JPEG, GIF and WebP images up to 10 MB
// and UTF-8 text files up to 1 MB, at most 8 per message (docs/EVERYDAY.md); it checks them again, so the
// checks here only save a wasted upload.

export const MAX_ATTACHMENTS = 8;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TEXT_MAX_BYTES = 1024 * 1024;

export type Attachment = { id: string; name: string; mime: string; bytes: number; kind: 'image' | 'text' };

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

/** A reason this file will not be sent, or null. Unknown sizes pass: the server decides. */
export function attachmentProblem(name: string, mime: string, size: number | undefined): string | null {
  const image = isImageMime(mime);
  if (size !== undefined && size > (image ? IMAGE_MAX_BYTES : TEXT_MAX_BYTES)) {
    return image ? `${name} is over the 10 MB limit for images.` : `${name} is over the 1 MB limit for text files.`;
  }
  return null;
}

/** One file as a `multipart/form-data` body. Built by hand because `expo/fetch` cannot send `{ uri }` parts. */
export function buildMultipart(field: string, name: string, mime: string, bytes: Uint8Array): { body: Uint8Array; contentType: string } {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let boundary = '----OpenDots';
  for (let i = 0; i < 24; i++) boundary += alphabet[Math.floor(Math.random() * alphabet.length)];
  // A quote, backslash or line break in a name would end the header early.
  const safeName = name.replace(/["\\\r\n]/g, '_');
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safeName}"\r\nContent-Type: ${mime.replace(/[\r\n]/g, '')}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Tolerant: `turn.started` lists what was attached; anything unreadable is left out. */
export function readAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const found: Attachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, mime, bytes, kind } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    found.push({
      id,
      name,
      mime: typeof mime === 'string' ? mime : '',
      bytes: typeof bytes === 'number' ? bytes : 0,
      kind: kind === 'image' ? 'image' : 'text',
    });
  }
  return found;
}
