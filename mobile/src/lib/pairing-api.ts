// The three calls pairing needs, against the server's /api/v1/auth routes (docs/AUTH.md):
// redeem a code for a device token, end a session, and ask whether a token still works.

import { normalizeServerUrl } from './server-url';

export type PairingErrorCode =
  | 'insecure'
  | 'invalid_code'
  | 'locked_out'
  | 'too_many_devices'
  | 'untrusted_host'
  | 'refused'
  | 'not_a_server'
  | 'unreachable'
  | 'wrong_scope'
  | 'server_error';

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  readonly retryAfter: number | null;

  constructor(code: PairingErrorCode, retryAfter: number | null = null) {
    super(code);
    this.name = 'PairingError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type PairedSession = {
  /** The normalized address the code was redeemed at; keep this one. */
  server: string;
  token: string;
  sessionId: number | null;
  scopes: string[];
  label: string | null;
};

type FetchLike = typeof fetch;

const TIMEOUT_MS = 15_000;

async function send(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw new PairingError('unreachable');
  } finally {
    clearTimeout(timer);
  }
}

function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** Ends the session the token belongs to. Best effort: the caller forgets the token either way. */
export async function signOutOnServer(server: string, token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await send(fetchImpl, `${server}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function pairDevice(args: {
  server: string;
  code: string;
  label: string;
  allowHttp: boolean;
  fetchImpl?: FetchLike;
}): Promise<PairedSession> {
  const fetchImpl = args.fetchImpl ?? fetch;
  // Defence in depth: the screens validate too, but this is the call that sends the code.
  const checked = normalizeServerUrl(args.server, { allowHttp: args.allowHttp });
  if (!checked.ok) throw new PairingError('insecure');
  const server = checked.url;

  const response = await send(fetchImpl, `${server}/api/v1/auth/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: args.code, label: args.label }),
  });

  if (response.status === 401) throw new PairingError('invalid_code');
  if (response.status === 409) throw new PairingError('too_many_devices');
  if (response.status === 429) throw new PairingError('locked_out', retryAfter(response));
  if (response.status === 421) throw new PairingError('untrusted_host');
  if (response.status === 403) throw new PairingError('refused');
  if (response.status >= 500) throw new PairingError('server_error');
  if (!response.ok) throw new PairingError('not_a_server');

  // Decode tolerantly: only the fields the app needs, unknown ones ignored.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PairingError('not_a_server');
  }
  const record = body as { token?: unknown; session?: { scopes?: unknown; session_id?: unknown; label?: unknown } } | null;
  const token = record?.token;
  const scopes = record?.session?.scopes;
  if (typeof token !== 'string' || !token || !Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    throw new PairingError('not_a_server');
  }

  // Pairing inherits the code's scopes. This app is a chat client: refuse anything with admin
  // access, and end that session so a stray full-access token is not left alive on the server.
  if (!scopes.includes('chat') || scopes.includes('admin')) {
    await signOutOnServer(server, token, fetchImpl);
    throw new PairingError('wrong_scope');
  }

  const sessionId = record?.session?.session_id;
  const label = record?.session?.label;
  return {
    server,
    token,
    sessionId: typeof sessionId === 'number' ? sessionId : null,
    scopes: scopes as string[],
    label: typeof label === 'string' ? label : null,
  };
}

/** 'revoked' only when the server says the token is no longer valid; anything else is 'unknown'. */
export async function checkSession(server: string, token: string, fetchImpl: FetchLike = fetch): Promise<'valid' | 'revoked' | 'unknown'> {
  try {
    const response = await send(fetchImpl, `${server}/api/v1/auth/session`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (response.ok) return 'valid';
    if (response.status === 401) return 'revoked';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function describePairingError(error: PairingError): string {
  switch (error.code) {
    case 'insecure':
      return 'This app only connects to a server over HTTPS.';
    case 'invalid_code':
      return 'That code is wrong, expired or already used. Create a new one in your server’s Settings → Devices.';
    case 'locked_out':
      return error.retryAfter
        ? `Too many wrong codes from this network. Try again in ${error.retryAfter} seconds.`
        : 'Too many wrong codes from this network. Try again in a few minutes.';
    case 'too_many_devices':
      return 'Your server has too many signed-in devices. Revoke one in Settings → Devices, then try again.';
    case 'untrusted_host':
      return 'Your server does not accept this address. Add the name to TRUSTED_HOSTS on the server (see the self-hosting guide).';
    case 'refused':
      return 'Your server refused the request. Check the address and any proxy in front of it.';
    case 'not_a_server':
      return 'That address answered, but it does not look like a Suparagent server.';
    case 'wrong_scope':
      return 'That code gives full access. The app only accepts a Chat only code. Create a new code with access set to Chat only.';
    case 'server_error':
      return 'Your server hit an error. Try again in a moment.';
    default:
      return 'Could not reach the server. Check the address, your connection, and that the server has a trusted HTTPS certificate.';
  }
}
