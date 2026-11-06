// What the phone does to get from "signed in to the hosted account" to "this phone has its own workspace token",
// and how it waits for a sleeping workspace. Plain TypeScript, no React Native imports; time is injected.
//
// The rules (hosted auth contract): reading the state never starts anything; only an explicit wake does, and it
// is made once, when the person opened the app or asked for it; waiting polls only while a wake is in progress,
// stops after a bounded time or run of failures, and never retries a blocked state (plan ended, hours used up).

import { HostedError, isBlocked, isStarting, type HostedApi, type Workspace, type WorkspaceGrant } from './hosted';

export type Sleep = (ms: number) => Promise<void>;

export const POLL_MS = 5_000;
export const GIVE_UP_MS = 15 * 60_000;
export const MAX_FAILED_READS = 10;
/** The "someone is looking at the workspace" signal: at most one every two minutes, the server's own limit. */
export const SIGNAL_MS = 2 * 60_000;

const real: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function blocked(workspace: Workspace, error: HostedError): Workspace {
  return { ...workspace, availability: error.code === 'usage_limit' ? 'usage_limit' : 'plan_required' };
}

/**
 * Reads the workspace's state and, when `wake` is true and it is asleep, wakes it once; then waits while it starts.
 * Returns as soon as the state is ready, blocked or asleep (asleep only when `wake` is false, or if it fell asleep
 * again while waiting: the person decides then). A session that ended throws `HostedError('session_invalid')`.
 */
export async function waitForWorkspace(
  api: HostedApi,
  token: string,
  options: {
    wake: boolean;
    onUpdate?: (workspace: Workspace) => void;
    isCancelled?: () => boolean;
    sleep?: Sleep;
    pollMs?: number;
    giveUpMs?: number;
    maxFailures?: number;
  },
): Promise<Workspace> {
  const sleep = options.sleep ?? real;
  const pollMs = options.pollMs ?? POLL_MS;
  const giveUpMs = options.giveUpMs ?? GIVE_UP_MS;
  const maxFailures = options.maxFailures ?? MAX_FAILED_READS;
  const update = (workspace: Workspace) => options.onUpdate?.(workspace);

  let workspace = await api.status(token);
  update(workspace);
  if (workspace.availability === 'ready' || isBlocked(workspace.availability)) return workspace;
  if (!isStarting(workspace.availability)) {
    // Asleep (or stopped): only an explicit wake changes that.
    if (!options.wake) return workspace;
    try {
      workspace = await api.wake(token);
    } catch (error) {
      if (error instanceof HostedError && (error.code === 'plan_required' || error.code === 'usage_limit')) {
        workspace = blocked(workspace, error);
        update(workspace);
        return workspace;
      }
      throw error;
    }
    update(workspace);
  }

  let waited = 0;
  let failures = 0;
  while (isStarting(workspace.availability)) {
    if (options.isCancelled?.()) return workspace;
    if (waited >= giveUpMs) {
      workspace = { ...workspace, availability: 'error' };
      update(workspace);
      return workspace;
    }
    const wait = Math.max(pollMs, (workspace.retryAfter ?? 0) * 1000);
    await sleep(wait);
    waited += wait;
    if (options.isCancelled?.()) return workspace;
    try {
      workspace = await api.status(token);
      failures = 0;
    } catch (error) {
      if (error instanceof HostedError && error.code === 'session_invalid') throw error;
      failures += 1;
      if (failures >= maxFailures) {
        workspace = { ...workspace, availability: 'error' };
        update(workspace);
        return workspace;
      }
      continue;
    }
    update(workspace);
  }
  return workspace;
}

export type Connected =
  | { kind: 'granted'; grant: WorkspaceGrant; workspace: Workspace }
  | { kind: 'not_ready'; workspace: Workspace };

/**
 * Gets this phone its own workspace token, waking the workspace first if that is needed. The grant is asked for only
 * once the workspace is ready (it never starts the workspace itself); if the workspace slips back to sleep between
 * the two, the wait and the ask are repeated a few times.
 */
export async function connectWorkspace(
  api: HostedApi,
  token: string,
  options: { wake: boolean; scope?: 'chat' | 'files'; onUpdate?: (workspace: Workspace) => void; isCancelled?: () => boolean; sleep?: Sleep; pollMs?: number; giveUpMs?: number; maxFailures?: number },
): Promise<Connected> {
  let last: Workspace = { plan: '', availability: 'error', retryAfter: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await waitForWorkspace(api, token, options);
    if (last.availability !== 'ready') return { kind: 'not_ready', workspace: last };
    try {
      return { kind: 'granted', grant: await api.createDevice(token, options.scope ?? 'chat'), workspace: last };
    } catch (error) {
      if (error instanceof HostedError && error.code === 'workspace_not_ready') continue;
      if (error instanceof HostedError && (error.code === 'plan_required' || error.code === 'usage_limit')) {
        return { kind: 'not_ready', workspace: blocked(last, error) };
      }
      throw error;
    }
  }
  return { kind: 'not_ready', workspace: { ...last, availability: 'error' } };
}

export type Recovery =
  | { kind: 'granted'; grant: WorkspaceGrant }
  | { kind: 'signed_out' }
  | { kind: 'later'; workspace: Workspace | null };

/**
 * The workspace said no to this phone's token (401): its grant was removed, or it ended there. If the account sign-in
 * still holds, ask for a new token, but only when the workspace is already running; nothing here wakes it. If the
 * account sign-in ended too, the person signs in again.
 */
export async function recoverWorkspaceToken(api: HostedApi, accountToken: string, scope: 'chat' | 'files' = 'chat'): Promise<Recovery> {
  try {
    await api.session(accountToken);
    const workspace = await api.status(accountToken);
    if (workspace.availability !== 'ready') return { kind: 'later', workspace };
    return { kind: 'granted', grant: await api.createDevice(accountToken, scope) };
  } catch (error) {
    if (error instanceof HostedError && error.code === 'session_invalid') return { kind: 'signed_out' };
    return { kind: 'later', workspace: null };
  }
}
