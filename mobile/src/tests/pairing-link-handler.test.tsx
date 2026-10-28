import { render } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { PairingLinkHandler } from '@/components/pairing-link-handler';

const mockNavigate = jest.fn();
let mockUrl: string | null = null;
let mockState: { status: 'loading' | 'unpaired' | 'paired' } = { status: 'unpaired' };

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate }) }));
jest.mock('expo-linking', () => ({ useLinkingURL: () => mockUrl }));
jest.mock('@/lib/auth-context', () => ({ useAuth: () => ({ state: mockState }) }));

const LINK = 'suparagent://pair?server=https%3A%2F%2Fdots.example.com#code=ABCD-EFGH';
const OTHER = 'suparagent://pair?server=https%3A%2F%2Fother.example.com#code=JKMN-PQRS';

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockUrl = LINK;
  mockState = { status: 'unpaired' };
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => alert.mockRestore());

describe('PairingLinkHandler', () => {
  it('fills in the pairing screen from a link, without connecting', async () => {
    await render(<PairingLinkHandler />);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/pair', params: { server: 'https://dots.example.com', code: 'ABCDEFGH' } });
  });

  it('waits until the saved pairing has been read', async () => {
    mockState = { status: 'loading' };
    const view = await render(<PairingLinkHandler />);
    expect(mockNavigate).not.toHaveBeenCalled();
    mockState = { status: 'unpaired' };
    await view.rerender(<PairingLinkHandler />);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does not tell you "Already paired" right after pairing from that same link', async () => {
    const view = await render(<PairingLinkHandler />);
    mockState = { status: 'paired' };
    await view.rerender(<PairingLinkHandler />);
    expect(alert).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('does not refill the used code after signing out', async () => {
    const view = await render(<PairingLinkHandler />);
    mockState = { status: 'paired' };
    await view.rerender(<PairingLinkHandler />);
    mockState = { status: 'unpaired' };
    await view.rerender(<PairingLinkHandler />);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('still handles a different link that arrives later', async () => {
    const view = await render(<PairingLinkHandler />);
    mockUrl = OTHER;
    await view.rerender(<PairingLinkHandler />);
    expect(mockNavigate).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenLastCalledWith({ pathname: '/pair', params: { server: 'https://other.example.com', code: 'JKMNPQRS' } });
  });

  it('tells you once when a new link arrives while already paired', async () => {
    mockState = { status: 'paired' };
    const view = await render(<PairingLinkHandler />);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    await view.rerender(<PairingLinkHandler />);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('ignores anything that is not a pairing link', async () => {
    mockUrl = 'suparagent://somewhere/else';
    await render(<PairingLinkHandler />);
    mockUrl = null;
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
