// Turns what a person typed or scanned into the server address the app will talk to.
// The bearer token travels in a header on every request, so plain HTTP is refused unless the caller allows it.

export type ServerUrl =
  | { ok: true; url: string; secure: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported_scheme' | 'insecure' };

const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;

export function normalizeServerUrl(input: string, options: { allowHttp: boolean }): ServerUrl {
  const text = input.trim();
  if (!text) return { ok: false, reason: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  // No user info, query or fragment: only scheme, host, optional port and an optional path prefix.
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s@]*)(\/[^?#\s]*)?$/i.exec(withScheme);
  if (!match) return { ok: false, reason: 'invalid' };
  const scheme = match[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: 'unsupported_scheme' };
  const hostPort = match[2];
  const host = HOST.exec(hostPort);
  if (!host) return { ok: false, reason: 'invalid' };
  const port = host[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return { ok: false, reason: 'invalid' };
  if (scheme === 'http' && !options.allowHttp) return { ok: false, reason: 'insecure' };
  const path = (match[3] ?? '').replace(/\/+$/, '');
  return { ok: true, url: `${scheme}://${hostPort.toLowerCase()}${path}`, secure: scheme === 'https' };
}

/** The part a person should check before connecting: host, port and any path prefix. */
export function serverLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

export function describeServerUrlProblem(reason: Extract<ServerUrl, { ok: false }>['reason']): string {
  switch (reason) {
    case 'empty':
      return 'Enter your server address.';
    case 'unsupported_scheme':
      return 'The address must start with https://.';
    case 'insecure':
      return 'This app only connects over HTTPS. Use your server’s HTTPS address (a reverse proxy or Tailscale Serve).';
    default:
      return 'That does not look like a server address. Example: https://dots.example.com';
  }
}
