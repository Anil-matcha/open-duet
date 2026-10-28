// Reads what a pairing QR code or link carries. Two forms are accepted:
//   suparagent://pair?server=<origin>#code=<code>   (the phone app link)
//   <origin>/pair#code=<code>                       (the web link shown beside it)

// Mirrors the server's code format (backend/app/auth/credentials.py): 8 characters from a
// 31-symbol alphabet without look-alikes. Checking here keeps a typo from counting as a wrong
// guess, because ten wrong codes lock an address out.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

export type PairingLink = { server: string | null; code: string };

/** Case, spaces and dashes do not matter. Returns null when it cannot be a code. */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export function formatPairingCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function pairs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = decode(eq === -1 ? '' : part.slice(eq + 1));
    if (key !== null && value !== null) out[key] = value;
  }
  return out;
}

export function parsePairingLink(text: string): PairingLink | null {
  const trimmed = text.trim();

  const app = /^suparagent:\/\/pair\/?(?:\?([^#]*))?(?:#(.*))?$/i.exec(trimmed);
  if (app) {
    const query = pairs(app[1]);
    const fragment = pairs(app[2]);
    const code = normalizePairingCode(fragment.code ?? query.code ?? '');
    if (!code) return null;
    return { server: query.server ?? fragment.server ?? null, code };
  }

  const web = /^(https?:\/\/[^/?#\s]+(?:\/[^?#\s]*?)?)\/pair\/?(?:\?[^#]*)?#(.*)$/i.exec(trimmed);
  if (web) {
    const code = normalizePairingCode(pairs(web[2]).code ?? '');
    if (!code) return null;
    return { server: web[1], code };
  }

  return null;
}
