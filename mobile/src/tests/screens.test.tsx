import { fireEvent, render, screen } from '@testing-library/react-native';

import Home from '../app';
import Pair from '../app/pair';

const mockPair = jest.fn();
let mockParams: { server?: string; code?: string } = {};
let mockState: unknown = { status: 'unpaired' };

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
});

describe('Home', () => {
  it('names the server this phone is paired with', async () => {
    mockState = { status: 'paired', server: 'https://dots.example.com', token: 't', label: 'My phone' };
    await render(<Home />);
    expect(screen.getByText(/dots\.example\.com/)).toBeTruthy();
  });
});

describe('Pair', () => {
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
