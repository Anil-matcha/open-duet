// Turns what a person typed or scanned into the server address the app will talk to.
// The bearer token travels in a header on every request, so plain HTTP is accepted only for addresses on the
// person's own network (see isLocalHost). Everything else needs HTTPS.

export type ServerUrl =
  | { ok: true; url: string; secure: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported_scheme' | 'insecure' };

const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;

export function normalizeServerUrl(input: string): ServerUrl {
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
  if (scheme === 'http' && !isLocalHost(hostOf(hostPort))) return { ok: false, reason: 'insecure' };
  const path = (match[3] ?? '').replace(/\/+$/, '');
  return { ok: true, url: `${scheme}://${hostPort.toLowerCase()}${path}`, secure: scheme === 'https' };
}

/** The host part of `host[:port]`, without the port and, for IPv6, still in its brackets. */
function hostOf(hostPort: string): string {
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1);
  const colon = hostPort.lastIndexOf(':');
  return colon === -1 ? hostPort : hostPort.slice(0, colon);
}

function ipv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  // A leading zero reads as octal in some parsers: refuse it rather than guess.
  if (parts.some((part, i) => part > 255 || (match[i + 1].length > 1 && match[i + 1].startsWith('0')))) return null;
  return parts;
}

/**
 * True for an address on this phone's own network, the only place plain HTTP is accepted: localhost, loopback,
 * the private IPv4 ranges (10/8, 172.16/12, 192.168/16, which include the Android emulator's 10.0.2.2), link-local
 * 169.254/16, IPv6 ::1 and unique-local fc00::/7, and mDNS `*.local` names. Not: any other name (even one that
 * resolves to a private address), single-label names, carrier-grade NAT 100.64/10, IPv4-mapped IPv6 and fe80::/10.
 * Takes the host alone, lower-case or not, with IPv6 in brackets.
 */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') && name.length > '.local'.length) return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name);
  if (name.startsWith('[') && name.endsWith(']')) {
    const address = name.slice(1, -1);
    if (!/^[0-9a-f:]+$/.test(address)) return false;
    if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
    const first = address.split(':')[0];
    return /^[0-9a-f]{1,4}$/.test(first) && (parseInt(first, 16) & 0xfe00) === 0xfc00;
  }
  const octets = ipv4(name);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** False for a response that came from plain HTTP on a non-local host, such as after a redirect. No URL is fine. */
export function responseAllowed(url: string | null | undefined): boolean {
  if (!url) return true;
  const match = /^http:\/\/([^/?#\s@]*)/i.exec(url);
  return !match || isLocalHost(hostOf(match[1]));
}

/** True when the address is plain HTTP (local only), so the traffic is not encrypted. */
export function isPlainHttp(url: string): boolean {
  return /^http:\/\//i.test(url);
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
      return 'The address must start with https:// (or http:// for an address on your own network).';
    case 'insecure':
      return 'Plain http:// works only for addresses on your own network, such as 192.168.1.5 or mybox.local. Use https:// for any other address.';
    default:
      return 'That does not look like a server address. Example: https://dots.example.com';
  }
}

/** Shown beside an http:// server, where nothing on the connection is encrypted. */
export const NOT_ENCRYPTED_NOTICE = 'Not encrypted. Anyone on this Wi-Fi network could read your chats.';
