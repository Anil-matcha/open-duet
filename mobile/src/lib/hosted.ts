// The hosted workspace's account API (the paid cloud workspace at suparagent.ai), as the phone uses it:
// sign in with an email code, read the workspace's state, wake it, ask for this phone's own workspace token.
// Plain TypeScript with no React Native imports. Contract: the hosted auth contract in the cloud docs.
//
// Two kinds of token exist and are never mixed: the ACCOUNT token (`odm_…`) goes only to these account calls,
// and the WORKSPACE token (`ods_…`, one per phone) goes only to the workspace API through `createApi`.
// Every request goes to one fixed origin, never to an address the server names, and no token is logged.

import { normalizeServerUrl, responseAllowed } from './server-url';

const PRODUCTION_ORIGIN = 'https://suparagent.ai';

/**
 * The hosted service's address: fixed in the app. A development build may point at a staging service with
 * EXPO_PUBLIC_HOSTED_ORIGIN; a release build cannot be redirected, and the value must pass the same address
 * rule as any server (https, or http on this network only).
 */
export function hostedOrigin(override: string | undefined = typeof __DEV__ !== 'undefined' && __DEV__ ? process.env.EXPO_PUBLIC_HOSTED_ORIGIN : undefined): string {
  if (override) {
    const parsed = normalizeServerUrl(override);
    if (parsed.ok) return parsed.url;
  }
  return PRODUCTION_ORIGIN;
}

export const HOSTED_ORIGIN = hostedOrigin();

export type Availability =
  | 'ready'
  | 'sleeping'
  | 'waking'
  | 'provisioning'
  | 'stopped'
  | 'plan_required'
  | 'usage_limit'
  | 'plan_ended'
  | 'needs_provider'
  | 'provider_limit'
  | 'error';

const KNOWN: readonly string[] = ['ready', 'sleeping', 'waking', 'provisioning', 'stopped', 'plan_required', 'usage_limit', 'plan_ended', 'needs_provider', 'provider_limit', 'error'];

export type Workspace = {
  plan: string;
  /** What the service says right now; an unknown word reads as `error`, never as a blank screen. */
  availability: Availability;
  /** Seconds the service asks to wait before looking again, when it says so. */
  retryAfter: number | null;
};

/** The workspace summary of an answer, or null when the answer has none. Unknown fields are ignored. */
export function readWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as { workspace?: unknown }).workspace ?? raw;
  if (!value || typeof value !== 'object') return null;
  const record = value as { plan?: unknown; availability?: unknown; retry_after?: unknown };
  if (typeof record.plan !== 'string') return null;
  const word = typeof record.availability === 'string' ? record.availability : 'error';
  return {
    plan: record.plan,
    availability: (KNOWN.includes(word) ? word : 'error') as Availability,
    retryAfter: typeof record.retry_after === 'number' && record.retry_after > 0 ? Math.ceil(record.retry_after) : null,
  };
}

export type HostedErrorCode =
  | 'unreachable'
  | 'rate_limited'
  | 'code_invalid'
  | 'no_eligible_workspace'
  | 'session_invalid'
  | 'plan_required'
  | 'usage_limit'
  | 'workspace_not_ready'
  | 'workspace_unavailable'
  | 'workspace_error'
  | 'too_many_devices'
  | 'scope_not_allowed'
  | 'device_id_invalid'
  | 'server_error';

export class HostedError extends Error {
  readonly status: number;
  readonly code: HostedErrorCode;
  readonly retryAfter: number | null;

  constructor(status: number, code: HostedErrorCode, retryAfter: number | null = null) {
    super(code);
    this.name = 'HostedError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const CODES: readonly string[] = [
  'rate_limited', 'code_invalid', 'no_eligible_workspace', 'session_invalid', 'plan_required', 'usage_limit',
  'workspace_not_ready', 'workspace_unavailable', 'workspace_error', 'too_many_devices', 'scope_not_allowed', 'device_id_invalid',
];

export type AccountSession = { token: string; expiresAt: string; email: string; workspace: Workspace | null };
export type WorkspaceGrant = { token: string; scopes: string[]; expiresAt: string; baseUrl: string };
export type Platform = 'android' | 'ios' | 'other';

type FetchLike = typeof fetch;

const TIMEOUT_MS = 20_000;

export function createHostedApi(options: { fetchImpl?: FetchLike; origin?: string } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? HOSTED_ORIGIN;
  const base = `${origin}/api/v1/accounts/mobile`;

  async function call(method: string, path: string, init: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!responseAllowed(response.url)) throw new Error('response came from an unsafe address');
    } catch {
      throw new HostedError(0, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    if (response.status !== 204) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const detail = (body as { detail?: unknown } | null)?.detail;
      const word = detail && typeof detail === 'object' ? (detail as { code?: unknown }).code : undefined;
      const seconds = Number(response.headers.get('retry-after'));
      throw new HostedError(
        response.status,
        typeof word === 'string' && CODES.includes(word) ? (word as HostedErrorCode) : response.status === 429 ? 'rate_limited' : response.status === 401 ? 'session_invalid' : 'server_error',
        Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null,
      );
    }
    return { status: response.status, body };
  }

  function sessionFrom(body: unknown, email: string): AccountSession {
    const record = (body ?? {}) as { account_token?: unknown; expires_at?: unknown; user?: { email?: unknown } };
    if (typeof record.account_token !== 'string' || !record.account_token.startsWith('odm_')) throw new HostedError(0, 'server_error');
    return {
      token: record.account_token,
      expiresAt: typeof record.expires_at === 'string' ? record.expires_at : '',
      email: typeof record.user?.email === 'string' ? record.user.email : email,
      workspace: readWorkspace(body),
    };
  }

  return {
    origin,
    /** Always answers the same, whether or not the address has an account. */
    startEmail: async (email: string): Promise<void> => {
      await call('POST', '/email/start', { body: { email } });
    },
    verifyEmail: async (args: { email: string; code: string; deviceId: string; label: string; platform: Platform }): Promise<AccountSession> => {
      const { body } = await call('POST', '/email/verify', {
        body: { email: args.email, code: args.code, device_id: args.deviceId, label: args.label, platform: args.platform },
      });
      return sessionFrom(body, args.email);
    },
    session: async (token: string): Promise<{ email: string; expiresAt: string; workspace: Workspace | null }> => {
      const { body } = await call('GET', '/session', { token });
      const record = (body ?? {}) as { user?: { email?: unknown }; expires_at?: unknown };
      return { email: typeof record.user?.email === 'string' ? record.user.email : '', expiresAt: typeof record.expires_at === 'string' ? record.expires_at : '', workspace: readWorkspace(body) };
    },
    refresh: async (token: string): Promise<{ token: string; expiresAt: string }> => {
      const { body } = await call('POST', '/refresh', { token });
      const record = (body ?? {}) as { account_token?: unknown; expires_at?: unknown };
      if (typeof record.account_token !== 'string' || !record.account_token.startsWith('odm_')) throw new HostedError(0, 'server_error');
      return { token: record.account_token, expiresAt: typeof record.expires_at === 'string' ? record.expires_at : '' };
    },
    /** Best effort: ends this account session and this phone's workspace token. */
    logout: async (token: string): Promise<boolean> => {
      try {
        await call('POST', '/logout', { token });
        return true;
      } catch {
        return false;
      }
    },
    /** Reads only: it starts nothing. */
    status: async (token: string): Promise<Workspace> => {
      const { body } = await call('GET', '/workspace/status', { token });
      return readWorkspace(body) ?? { plan: '', availability: 'error', retryAfter: null };
    },
    /** The only call that starts the workspace. Make it when the person opened the app or asked for it. */
    wake: async (token: string): Promise<Workspace> => {
      const { body } = await call('POST', '/workspace/wake', { token });
      return readWorkspace(body) ?? { plan: '', availability: 'error', retryAfter: null };
    },
    /** "The person is looking at the workspace": one every couple of minutes, only while it is on screen. */
    signalActive: async (token: string): Promise<void> => {
      await call('POST', '/workspace/active', { token });
    },
    /** This phone's own workspace token, shown once. Chat only unless `files` is asked for. */
    createDevice: async (token: string, scope: 'chat' | 'files' = 'chat'): Promise<WorkspaceGrant> => {
      const { body } = await call('POST', '/devices', { token, body: { scope } });
      const record = (body ?? {}) as { device_token?: unknown; scopes?: unknown; expires_at?: unknown; base_url?: unknown };
      if (typeof record.device_token !== 'string' || !record.device_token.startsWith('ods_')) throw new HostedError(0, 'server_error');
      return {
        token: record.device_token,
        scopes: Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === 'string') : [],
        expiresAt: typeof record.expires_at === 'string' ? record.expires_at : '',
        // Informational only: the app keeps talking to its own fixed origin, whatever the answer says.
        baseUrl: typeof record.base_url === 'string' ? record.base_url : '',
      };
    },
  };
}

export type HostedApi = ReturnType<typeof createHostedApi>;

// --- what to tell the person -------------------------------------------------------------------

/** States in which asking again changes nothing until the plan, the usage period or the service does. */
export function isBlocked(availability: Availability): boolean {
  return ['plan_required', 'usage_limit', 'plan_ended', 'needs_provider', 'error'].includes(availability);
}

/** States that start by themselves and only need a look now and then. */
export function isStarting(availability: Availability): boolean {
  return ['waking', 'provisioning', 'provider_limit'].includes(availability);
}

export function describeAvailability(availability: Availability): { title: string; detail: string } {
  switch (availability) {
    case 'ready':
      return { title: 'Your workspace is ready', detail: '' };
    case 'sleeping':
    case 'stopped':
      return { title: 'Your workspace is asleep', detail: 'It sleeps when it is not in use. Waking it takes about a minute.' };
    case 'waking':
    case 'provisioning':
      return { title: 'Starting your workspace', detail: 'This can take a minute or two. You can leave this screen open.' };
    case 'provider_limit':
      return { title: 'Your workspace is busy starting', detail: 'The service is at its limit for a moment. This tries again by itself.' };
    case 'plan_required':
    case 'plan_ended':
      return { title: 'Your plan has ended', detail: 'Choose a hosted plan on suparagent.ai to use your workspace again. Your data is kept.' };
    case 'usage_limit':
      return { title: 'This month’s hours are used up', detail: 'Your workspace is stopped until your plan renews or you change plans on suparagent.ai.' };
    case 'needs_provider':
      return { title: 'Your workspace needs a provider', detail: 'Connect a sandbox provider on suparagent.ai, then come back.' };
    default:
      return { title: 'Your workspace has a problem', detail: 'Something went wrong starting it. Try again in a moment.' };
  }
}

export function describeHostedError(error: HostedError): string {
  switch (error.code) {
    case 'unreachable':
      return 'Cannot reach suparagent.ai. Check your connection and try again.';
    case 'rate_limited':
      return error.retryAfter ? `Too many attempts. Try again in ${error.retryAfter} seconds.` : 'Too many attempts. Try again in a little while.';
    case 'code_invalid':
      return 'That code is wrong or has expired. Check it, or ask for a new one.';
    case 'no_eligible_workspace':
      return 'This account has no paid hosted workspace. Choose a plan on suparagent.ai, then sign in again.';
    case 'session_invalid':
      return 'Your hosted sign-in ended. Sign in again.';
    case 'plan_required':
    case 'usage_limit':
      return describeAvailability(error.code).detail;
    case 'workspace_not_ready':
      return 'Your workspace is not running yet.';
    case 'too_many_devices':
      return 'Too many phones are connected to this account. Remove one on suparagent.ai/account/phones, then try again.';
    case 'workspace_error':
      return 'Your workspace could not set up this phone. Try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}
