import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Linking, Text } from 'react-native';

import { HostedGate } from '@/components/hosted-gate';
import { HostedError, type Availability, type Workspace } from '@/lib/hosted';
import { SIGNAL_MS } from '@/lib/hosted-flow';
import { useWorkspace } from '@/lib/workspace-context';

const mockSignOut = jest.fn(async () => undefined);
const mockHostedEnded = jest.fn();
let mockState: unknown;
let mockPath = '/';
const mockApi = { status: jest.fn(), wake: jest.fn(), signalActive: jest.fn() };

jest.mock('expo-router', () => ({ usePathname: () => mockPath }));
jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ state: mockState, signOut: mockSignOut, hostedEnded: mockHostedEnded }),
}));
jest.mock('@/lib/hosted', () => ({ ...jest.requireActual('@/lib/hosted'), createHostedApi: () => mockApi }));

const ws = (availability: Availability, retryAfter: number | null = null): Workspace => ({ plan: 'starter', availability, retryAfter });
const HOSTED = { status: 'paired', server: 'https://suparagent.ai', token: 'ods_x', label: 'Pixel', scopes: ['chat'], hosted: { email: 'me@example.com', accountToken: 'odm_acct' } };

/** A child that reports a 503, as a screen's failed call does. */
function Reporter() {
  const { unavailable } = useWorkspace();
  return <Text onPress={unavailable}>report 503</Text>;
}
const app = (
  <HostedGate>
    <Text>app content</Text>
    <Reporter />
  </HostedGate>
);

let appStateHandlers: ((next: string) => void)[] = [];
let appStateNow = 'active';
const realCurrentState = Object.getOwnPropertyDescriptor(AppState, 'currentState');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = HOSTED;
  mockPath = '/';
  mockApi.status.mockReset().mockResolvedValue(ws('ready'));
  mockApi.wake.mockReset().mockResolvedValue(ws('waking'));
  mockApi.signalActive.mockReset().mockResolvedValue(undefined);
  appStateHandlers = [];
  appStateNow = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (next: string) => void) => {
    appStateHandlers.push(handler);
    return { remove: () => void (appStateHandlers = appStateHandlers.filter((h) => h !== handler)) };
  }) as never);
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => appStateNow });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (realCurrentState) Object.defineProperty(AppState, 'currentState', realCurrentState);
});

const flush = () => act(async () => {});

describe('HostedGate', () => {
  it('lets a self-hosted phone straight through and asks the service nothing', async () => {
    mockState = { status: 'paired', server: 'https://dots.example.com', token: 'ods_x', label: 'Pixel', scopes: ['chat'] };
    await render(app);
    expect(screen.getByText('app content')).toBeTruthy();
    expect(mockApi.status).not.toHaveBeenCalled();
    expect(mockApi.wake).not.toHaveBeenCalled();
  });

  it('keeps the app hidden until the workspace is ready, then shows it without waking anything', async () => {
    let resolve: (value: Workspace) => void = () => undefined;
    mockApi.status.mockReturnValue(new Promise<Workspace>((r) => (resolve = r)));
    await render(app);
    expect(screen.queryByText('app content', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText('Opening your workspace')).toBeTruthy();
    await act(async () => resolve(ws('ready')));
    expect(screen.getByText('app content')).toBeTruthy();
    expect(screen.queryByText('Opening your workspace')).toBeNull();
    expect(mockApi.wake).not.toHaveBeenCalled();
  });

  it('wakes a sleeping workspace once because the person just opened the app, and waits while it starts', async () => {
    jest.useFakeTimers();
    mockApi.status.mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready'));
    await render(app);
    await flush();
    expect(mockApi.wake).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Starting your workspace')).toBeTruthy();
    expect(screen.queryByText('app content', { includeHiddenElements: true })).toBeNull();
    await act(async () => void (await jest.advanceTimersByTimeAsync(5000)));
    expect(screen.getByText('app content')).toBeTruthy();
    expect(mockApi.wake).toHaveBeenCalledTimes(1);
  });

  it('shows a blocked state, never wakes or retries it, and checks again only when asked', async () => {
    jest.useFakeTimers();
    mockApi.status.mockResolvedValue(ws('usage_limit'));
    await render(app);
    await flush();
    expect(screen.getByText('This month’s hours are used up')).toBeTruthy();
    expect(screen.queryByText('app content', { includeHiddenElements: true })).toBeNull();
    await act(async () => void (await jest.advanceTimersByTimeAsync(10 * 60_000)));
    expect(mockApi.status).toHaveBeenCalledTimes(1); // nothing retries by itself
    expect(mockApi.wake).not.toHaveBeenCalled();

    mockApi.status.mockResolvedValue(ws('ready'));
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(mockApi.status).toHaveBeenCalledTimes(2);
    expect(mockApi.wake).not.toHaveBeenCalled(); // checking is not waking
    expect(screen.getByText('app content')).toBeTruthy();
  });

  it('does not wake a workspace that has come back asleep just because the person checked again', async () => {
    mockApi.status.mockResolvedValue(ws('plan_required'));
    await render(app);
    await flush();
    mockApi.status.mockResolvedValue(ws('sleeping')); // the plan was renewed; the workspace is asleep
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(mockApi.wake).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Wake my workspace' })).toBeTruthy(); // the person decides
  });

  it('opens the plan page for a blocked state and lets the person sign out', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    mockApi.status.mockResolvedValue(ws('plan_required'));
    await render(app);
    await flush();
    await fireEvent.press(screen.getByRole('link', { name: 'Open plan and billing' }));
    expect(open).toHaveBeenCalledWith('https://suparagent.ai/account/billing');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('offers a wake button for a workspace that is asleep and wakes it only when pressed', async () => {
    mockApi.status.mockResolvedValue(ws('ready'));
    await render(app);
    await flush();
    mockApi.status.mockReset().mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready'));
    mockApi.wake.mockClear();
    // A call finds the workspace gone (503): the app stays, the gate reads the state and wakes nothing.
    await fireEvent.press(screen.getByText('report 503'));
    await flush();
    expect(mockApi.wake).not.toHaveBeenCalled();
    expect(screen.getByText('Your workspace is asleep')).toBeTruthy();
    // Kept mounted underneath, so the place is not lost; hidden from a screen reader while the notice is up.
    expect(screen.getByText('app content', { includeHiddenElements: true })).toBeTruthy();
    mockApi.status.mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready')); // still asleep when pressed
    await fireEvent.press(screen.getByRole('button', { name: 'Wake my workspace' }));
    await flush();
    expect(mockApi.wake).toHaveBeenCalledTimes(1);
  });

  it('reads a burst of 503s as one look', async () => {
    await render(app);
    await flush();
    mockApi.status.mockClear();
    await fireEvent.press(screen.getByText('report 503'));
    await fireEvent.press(screen.getByText('report 503'));
    await fireEvent.press(screen.getByText('report 503'));
    await flush();
    expect(mockApi.status).toHaveBeenCalledTimes(1);
  });

  it('looks again, and wakes if asleep, when the app comes back to the front', async () => {
    await render(app);
    await flush();
    expect(mockApi.status).toHaveBeenCalledTimes(1);
    mockApi.status.mockResolvedValueOnce(ws('sleeping')).mockResolvedValue(ws('ready'));
    await act(async () => appStateHandlers.forEach((handler) => handler('active')));
    await flush();
    expect(mockApi.status).toHaveBeenCalledTimes(2);
    expect(mockApi.wake).toHaveBeenCalledTimes(1);
    await act(async () => appStateHandlers.forEach((handler) => handler('background')));
    await flush();
    expect(mockApi.status).toHaveBeenCalledTimes(2); // going to the background looks at nothing
  });

  it('says so when the workspace cannot be reached, and tries again when asked', async () => {
    mockApi.status.mockRejectedValue(new HostedError(0, 'unreachable'));
    await render(app);
    await flush();
    expect(screen.getByText('Cannot reach your workspace')).toBeTruthy();
    expect(screen.queryByText('app content', { includeHiddenElements: true })).toBeNull();
    mockApi.status.mockResolvedValue(ws('ready'));
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByText('app content')).toBeTruthy();
  });

  it('asks for a new sign-in when the account session ended', async () => {
    mockApi.status.mockRejectedValue(new HostedError(401, 'session_invalid'));
    await render(app);
    await flush();
    expect(mockHostedEnded).toHaveBeenCalledTimes(1);
  });
});

describe('the "someone is looking" signal', () => {
  it('is sent while a conversation is on screen, now and every couple of minutes, with the account token', async () => {
    jest.useFakeTimers();
    mockPath = '/thread/7';
    await render(app);
    await flush();
    expect(mockApi.signalActive).toHaveBeenCalledTimes(1);
    expect(mockApi.signalActive).toHaveBeenCalledWith('odm_acct');
    await act(async () => void (await jest.advanceTimersByTimeAsync(SIGNAL_MS)));
    expect(mockApi.signalActive).toHaveBeenCalledTimes(2);
    await act(async () => void (await jest.advanceTimersByTimeAsync(SIGNAL_MS)));
    expect(mockApi.signalActive).toHaveBeenCalledTimes(3);
  });

  it('is sent for a room too, and not on the list, settings or search', async () => {
    jest.useFakeTimers();
    for (const path of ['/', '/settings', '/search', '/agents']) {
      mockPath = path;
      const view = await render(app);
      await flush();
      await view.unmount();
    }
    expect(mockApi.signalActive).not.toHaveBeenCalled();
    mockPath = '/rooms/3';
    await render(app);
    await flush();
    expect(mockApi.signalActive).toHaveBeenCalledTimes(1);
  });

  it('stops in the background, starts again in front, and never starts a workspace', async () => {
    jest.useFakeTimers();
    mockPath = '/thread/7';
    await render(app);
    await flush();
    expect(mockApi.signalActive).toHaveBeenCalledTimes(1);
    await act(async () => appStateHandlers.forEach((handler) => handler('background')));
    await act(async () => void (await jest.advanceTimersByTimeAsync(SIGNAL_MS * 3)));
    expect(mockApi.signalActive).toHaveBeenCalledTimes(1);
    await act(async () => appStateHandlers.forEach((handler) => handler('active')));
    await flush();
    expect(mockApi.signalActive).toHaveBeenCalledTimes(2);
    expect(mockApi.wake).not.toHaveBeenCalled();
  });

  it('is not sent while the workspace is not ready', async () => {
    jest.useFakeTimers();
    mockPath = '/thread/7';
    mockApi.status.mockResolvedValue(ws('usage_limit'));
    await render(app);
    await flush();
    await act(async () => void (await jest.advanceTimersByTimeAsync(SIGNAL_MS * 2)));
    expect(mockApi.signalActive).not.toHaveBeenCalled();
  });

  it('asks for a new sign-in if the service says the account session ended', async () => {
    mockPath = '/thread/7';
    mockApi.signalActive.mockRejectedValue(new HostedError(401, 'session_invalid'));
    await render(app);
    await flush();
    expect(mockHostedEnded).toHaveBeenCalledTimes(1);
  });
});
