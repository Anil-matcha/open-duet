import { fireEvent, render, screen } from '@testing-library/react-native';

import Pair from '../app/pair';

const mockPair = jest.fn();
let mockCheck: string = 'idle';
let mockParams: { server?: string; code?: string } = {};
let mockState: unknown = { status: 'unpaired' };

jest.mock('@/lib/use-server-check', () => ({ useServerCheck: () => mockCheck }));
jest.mock('@/lib/auth-context', () => ({
  ALLOW_HTTP: false,
  useAuth: () => ({ state: mockState, notice: null, pair: mockPair, signOut: jest.fn() }),
}));

jest.mock('expo-router', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Link: ({ children }: { children: string }) => createElement(Text, null, children),
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
  };
});

beforeEach(() => {
  mockPair.mockReset();
  mockParams = {};
  mockState = { status: 'unpaired' };
  mockCheck = 'idle';
});

describe('Pair', () => {
  it('lists the steps, with the QR code as the main way in and typing as the other', async () => {
    await render(<Pair />);
    expect(screen.getByRole('header', { name: 'Connect to your server' })).toBeTruthy();
    expect(screen.getByText(/open Settings → Devices/)).toBeTruthy();
    expect(screen.getByText(/Chat only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan QR code' })).toBeTruthy();
    expect(screen.getByText('or type them in')).toBeTruthy();
    expect(screen.getByText(/Trouble connecting/)).toBeTruthy();
  });

  it('checks the address as it is typed and says what it found', async () => {
    const view = await render(<Pair />);
    // Nothing is said about an address that is not valid yet.
    mockCheck = 'checking';
    await fireEvent.changeText(screen.getByPlaceholderText('https://dots.example.com'), 'http://192.168.1.5:8000');
    expect(screen.queryByText('Checking the address…')).toBeNull();

    await fireEvent.changeText(screen.getByPlaceholderText('https://dots.example.com'), 'dots.example.com');
    expect(screen.getByText('Checking the address…')).toBeTruthy();

    mockCheck = 'ok';
    await view.rerender(<Pair />);
    expect(screen.getByText(/Found your server/)).toBeTruthy();

    mockCheck = 'unreachable';
    await view.rerender(<Pair />);
    expect(screen.getByText(/Cannot reach this address/)).toBeTruthy();
    expect(screen.queryByText(/Found your server/)).toBeNull();

    mockCheck = 'needs_setup';
    await view.rerender(<Pair />);
    expect(screen.getByText(/no owner account yet/)).toBeTruthy();
  });

  it('still lets the person try Connect when the check could not reach the server', async () => {
    mockCheck = 'unreachable';
    mockParams = { server: 'https://dots.example.com', code: 'ABCDEFGH' };
    await render(<Pair />);
    expect(screen.getByRole('button', { name: 'Connect' }).props.accessibilityState?.disabled).toBeFalsy();
  });

  it('keeps Connect disabled until the address and code are valid', async () => {
    await render(<Pair />);
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect.props.accessibilityState?.disabled ?? connect.props.disabled).toBeTruthy();

    await fireEvent.changeText(screen.getByPlaceholderText('https://dots.example.com'), 'dots.example.com');
    await fireEvent.changeText(screen.getByPlaceholderText('ABCD-EFGH'), 'abcd-efgh');
    expect(screen.getByText('dots.example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' }).props.accessibilityState?.disabled).toBeFalsy();
  });

  it('shows why plain http is refused', async () => {
    await render(<Pair />);
    await fireEvent.changeText(screen.getByPlaceholderText('https://dots.example.com'), 'http://192.168.1.5:8000');
    expect(screen.getByText(/only connects over HTTPS/)).toBeTruthy();
  });

  it('fills the fields from a link but does not connect by itself', async () => {
    mockParams = { server: 'https://dots.example.com', code: 'ABCDEFGH' };
    await render(<Pair />);
    expect(screen.getByDisplayValue('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByDisplayValue('https://dots.example.com')).toBeTruthy();
    expect(screen.getByText(/Make sure this is your own server/)).toBeTruthy();
    expect(mockPair).not.toHaveBeenCalled();
  });

  it('connects with the normalized address and code when Connect is pressed', async () => {
    mockPair.mockResolvedValue(undefined);
    mockParams = { server: 'https://dots.example.com/', code: 'abcd-efgh' };
    await render(<Pair />);
    await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
    expect(mockPair).toHaveBeenCalledWith({ server: 'https://dots.example.com', code: 'ABCDEFGH' });
  });
});
