import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import HostedSignIn from '../app/hosted';
import Pair from '../app/pair';
import Settings from '../app/settings';
import { HostedError, type Availability, type Workspace } from '@/lib/hosted';

const mockPush = jest.fn();
const mockSignOut = jest.fn(async () => undefined);
const mockHostedSignIn = jest.fn();
const mockHostedContinue = jest.fn();
let mockState: unknown;
let mockSaved: { token: string; email: string; expiresAt: string } | null = null;
const mockStartEmail = jest.fn();
const mockClearAccount = jest.fn(async () => undefined);

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/use-server-check', () => ({ useServerCheck: () => 'idle' }));
jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ state: mockState, notice: null, pair: jest.fn(), hostedSignIn: mockHostedSignIn, hostedContinue: mockHostedContinue, signOut: mockSignOut }),
}));
jest.mock('@/lib/hosted-credentials', () => ({
  loadHostedAccount: async () => mockSaved,
  clearHostedAccount: () => mockClearAccount(),
}));
jest.mock('@/lib/hosted', () => ({ ...jest.requireActual('@/lib/hosted'), createHostedApi: () => ({ startEmail: mockStartEmail }) }));

const ws = (availability: Availability): Workspace => ({ plan: 'starter', availability, retryAfter: null });
const flush = () => act(async () => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { status: 'unpaired' };
  mockSaved = null;
  mockStartEmail.mockReset().mockResolvedValue(undefined);
  mockHostedSignIn.mockReset();
  mockHostedContinue.mockReset();
});

async function toCodeStep(email = 'Me@Example.com') {
  await render(<HostedSignIn />);
  await flush();
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), email);
  await fireEvent.press(screen.getByRole('button', { name: 'Send me a code' }));
  await flush();
}

describe('Pair', () => {
  it('offers the hosted workspace first and the server pairing as the other way', async () => {
    await render(<Pair />);
    expect(screen.getByText('Use my hosted workspace')).toBeTruthy();
    expect(screen.getByText('or connect to a server you run')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Connect to my hosted workspace' }));
    expect(mockPush).toHaveBeenCalledWith('/hosted');
    // The server pairing is unchanged.
    expect(screen.getByRole('header', { name: 'Connect to your server' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan QR code' })).toBeTruthy();
  });
});

describe('HostedSignIn', () => {
  it('asks for the email first, and sends a code only for a valid one', async () => {
    await render(<HostedSignIn />);
    await flush();
    const send = screen.getByRole('button', { name: 'Send me a code' });
    expect(send.props.accessibilityState?.disabled ?? send.props.disabled).toBeTruthy();
    await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'not an email');
    expect(screen.getByText('Enter the email address of your account.')).toBeTruthy();
    expect(mockStartEmail).not.toHaveBeenCalled();
    expect(screen.getByText(/paid plan/)).toBeTruthy();
    expect(screen.getByText(/not copied/)).toBeTruthy();
  });

  it('sends the code to the typed address in lower case, and says the same whether or not the account exists', async () => {
    await toCodeStep('  Me@Example.com ');
    expect(mockStartEmail).toHaveBeenCalledWith('me@example.com');
    expect(screen.getByText(/If me@example.com has an account, we sent it a 6-digit code/)).toBeTruthy();
    expect(screen.getByPlaceholderText('123456')).toBeTruthy();
  });

  it('keeps Sign in disabled until the code has six digits, then signs in with the address and code', async () => {
    mockHostedSignIn.mockResolvedValue({ kind: 'connected' });
    await toCodeStep();
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    expect(signIn.props.accessibilityState?.disabled ?? signIn.props.disabled).toBeTruthy();
    await fireEvent.changeText(screen.getByPlaceholderText('123456'), '12 34');
    expect(screen.getByText('The code has 6 digits.')).toBeTruthy();
    await fireEvent.changeText(screen.getByPlaceholderText('123456'), '123 456');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await flush();
    expect(mockHostedSignIn).toHaveBeenCalledTimes(1);
    expect(mockHostedSignIn.mock.calls[0][0]).toMatchObject({ email: 'me@example.com', code: '123456' });
  });

  it('shows the workspace starting while it waits, in plain words', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockHostedSignIn.mockImplementation(({ onUpdate }: { onUpdate: (w: Workspace) => void }) => {
      onUpdate(ws('waking'));
      return new Promise((resolve) => (finish = resolve));
    });
    await toCodeStep();
    await fireEvent.changeText(screen.getByPlaceholderText('123456'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await flush();
    expect(screen.getByText('Starting your workspace')).toBeTruthy();
    expect(screen.getByText(/minute or two/)).toBeTruthy();
    await act(async () => finish({ kind: 'connected' }));
  });

  it('explains a workspace that is blocked, with a way to check again and to see the plan, and never retries by itself', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    mockHostedSignIn.mockResolvedValue({ kind: 'waiting', workspace: ws('usage_limit') });
    await toCodeStep();
    await fireEvent.changeText(screen.getByPlaceholderText('123456'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await flush();
    expect(screen.getByText('This month’s hours are used up')).toBeTruthy();
    expect(mockHostedContinue).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('link', { name: 'Open plan and billing' }));
    expect(open).toHaveBeenCalledWith('https://suparagent.ai/account/billing');
    mockHostedContinue.mockResolvedValue({ kind: 'connected' });
    await fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(mockHostedContinue).toHaveBeenCalledTimes(1);
  });

  it('shows what went wrong without codes, and offers the plans to an account that has none', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await toCodeStep();
    await fireEvent.changeText(screen.getByPlaceholderText('123456'), '123456');
    mockHostedSignIn.mockRejectedValueOnce(new HostedError(401, 'code_invalid'));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await flush();
    expect(screen.getByText(/code is wrong or has expired/)).toBeTruthy();
    expect(screen.getByPlaceholderText('123456')).toBeTruthy(); // still on the code step to try again
    expect(screen.queryByText(/code_invalid/)).toBeNull();

    mockHostedSignIn.mockRejectedValueOnce(new HostedError(403, 'no_eligible_workspace'));
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await flush();
    expect(screen.getByText(/no paid hosted workspace/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'See hosted plans' }));
    expect(open).toHaveBeenCalledWith('https://suparagent.ai/pricing');
  });

  it('shows a failed send, and the wait the service asks for', async () => {
    mockStartEmail.mockRejectedValue(new HostedError(429, 'rate_limited', 45));
    await render(<HostedSignIn />);
    await flush();
    await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'me@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send me a code' }));
    await flush();
    expect(screen.getByText(/Try again in 45 seconds/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('123456')).toBeNull(); // still on the email step
  });

  it('does not let a new code be asked for again within the minute', async () => {
    await toCodeStep();
    expect(mockStartEmail).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Send a new code' }));
    await flush();
    expect(mockStartEmail).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Wait a minute before asking for another code.')).toBeTruthy();
  });

  it('lets the person go back and use a different email', async () => {
    await toCodeStep();
    await fireEvent.press(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });

  it('carries on a sign-in that stopped halfway, or starts over', async () => {
    mockSaved = { token: 'odm_x', email: 'me@example.com', expiresAt: '' };
    mockHostedContinue.mockResolvedValue({ kind: 'connected' });
    await render(<HostedSignIn />);
    await flush();
    expect(screen.getByText('Signed in as me@example.com')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(mockHostedContinue).toHaveBeenCalledTimes(1);
  });

  it('forgets the half-finished sign-in when the person chooses another account', async () => {
    mockSaved = { token: 'odm_x', email: 'me@example.com', expiresAt: '' };
    await render(<HostedSignIn />);
    await flush();
    await fireEvent.press(screen.getByRole('button', { name: 'Use a different account' }));
    await flush();
    expect(mockClearAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });

  it('goes back to the email when the half-finished sign-in has ended', async () => {
    mockSaved = { token: 'odm_x', email: 'me@example.com', expiresAt: '' };
    mockHostedContinue.mockRejectedValue(new HostedError(401, 'session_invalid'));
    await render(<HostedSignIn />);
    await flush();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(screen.getByText(/sign-in ended/)).toBeTruthy();
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });
});

describe('Settings of a hosted phone', () => {
  const hosted = { status: 'paired', server: 'https://suparagent.ai', token: 'ods_x', label: 'Pixel 8', scopes: ['chat'], hosted: { email: 'me@example.com', accountToken: 'odm_acct' } };

  it('shows the workspace and the account instead of a server address, and chat-only access', async () => {
    mockState = hosted;
    await render(<Settings />);
    expect(screen.getByText('Hosted (suparagent.ai)')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
    expect(screen.getByText('Pixel 8')).toBeTruthy();
    expect(screen.getByText('Chat only')).toBeTruthy();
    expect(screen.queryByText('Server address')).toBeNull();
    expect(screen.queryByText('Agents')).toBeNull(); // a hosted phone cannot edit agents
    expect(screen.queryByText(/not encrypted/i)).toBeNull();
  });

  it('says chat and files when the owner allowed files', async () => {
    mockState = { ...hosted, scopes: ['chat', 'files'] };
    await render(<Settings />);
    expect(screen.getByText('Chat and files')).toBeTruthy();
  });

  it('points to the connected phones page on the site', async () => {
    mockState = hosted;
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('link', { name: /Connected phones/ }));
    expect(open).toHaveBeenCalledWith('https://suparagent.ai/account/phones');
  });

  it('signs out after asking, in words that say the data stays in the cloud', async () => {
    mockState = hosted;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<Settings />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out of the hosted workspace' }));
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe('Sign out of your hosted workspace?');
    expect(message).toMatch(/stay in the cloud/);
    await act(async () => buttons.find((b) => b.text === 'Sign out')?.onPress?.());
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the self-hosted wording for a server phone', async () => {
    mockState = { status: 'paired', server: 'https://dots.example.com', token: 'ods_x', label: 'Pixel', scopes: ['chat'] };
    await render(<Settings />);
    expect(screen.getByText('Server address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out and forget this server' })).toBeTruthy();
    expect(screen.queryByText(/Connected phones/)).toBeNull();
  });
});
