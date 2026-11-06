import { renderHook } from '@testing-library/react-native';

import { useRevoked } from '@/lib/use-revoked';

const mockRevoked = jest.fn();
const mockUnavailable = jest.fn();
let mockState: unknown;

jest.mock('@/lib/auth-context', () => ({ useAuth: () => ({ state: mockState, revoked: mockRevoked }) }));
jest.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ unavailable: mockUnavailable }) }));

beforeEach(() => jest.clearAllMocks());

describe('useRevoked', () => {
  it('for a hosted phone renews the token and has the gate read the workspace, because the plan may have ended', async () => {
    mockState = { status: 'paired', server: 'https://suparagent.ai', token: 'ods_x', label: 'P', scopes: ['chat'], hosted: { email: 'a@b.co', accountToken: 'odm_x' } };
    const { result } = await renderHook(() => useRevoked());
    result.current();
    expect(mockRevoked).toHaveBeenCalledTimes(1);
    expect(mockUnavailable).toHaveBeenCalledTimes(1);
  });

  it('for a server phone only signs it out', async () => {
    mockState = { status: 'paired', server: 'https://dots.example.com', token: 'ods_x', label: 'P', scopes: ['chat'] };
    const { result } = await renderHook(() => useRevoked());
    result.current();
    expect(mockRevoked).toHaveBeenCalledTimes(1);
    expect(mockUnavailable).not.toHaveBeenCalled();
  });
});
