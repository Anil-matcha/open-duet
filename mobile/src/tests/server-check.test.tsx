import { act, renderHook } from '@testing-library/react-native';

import { checkServer, type ServerCheck } from '@/lib/pairing-api';
import { useServerCheck } from '@/lib/use-server-check';

jest.mock('@/lib/pairing-api', () => ({ checkServer: jest.fn() }));
const mockCheck = checkServer as jest.Mock;

const settle = async (ms = 700) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  jest.useFakeTimers();
  mockCheck.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('useServerCheck', () => {
  it('does nothing without an address', async () => {
    const { result } = await renderHook(() => useServerCheck(null));
    await settle();
    expect(result.current).toBe('idle');
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('waits for a pause in typing, then reports what the address answered', async () => {
    mockCheck.mockResolvedValue('ok' satisfies ServerCheck);
    const { result } = await renderHook(() => useServerCheck('https://dots.example.com'));
    expect(result.current).toBe('checking');
    expect(mockCheck).not.toHaveBeenCalled();
    await settle();
    expect(mockCheck).toHaveBeenCalledWith('https://dots.example.com');
    expect(result.current).toBe('ok');
  });

  it('asks once for an address that changes while the person types', async () => {
    mockCheck.mockResolvedValue('ok');
    const { rerender } = await renderHook(({ server }: { server: string }) => useServerCheck(server), { initialProps: { server: 'https://d' } });
    await settle(300);
    await rerender({ server: 'https://dots' });
    await settle(300);
    await rerender({ server: 'https://dots.example.com' });
    await settle();
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockCheck).toHaveBeenCalledWith('https://dots.example.com');
  });

  it('never shows an answer for an address that has since changed', async () => {
    let answerOld!: (value: ServerCheck) => void;
    mockCheck.mockReturnValueOnce(new Promise<ServerCheck>((resolve) => (answerOld = resolve))).mockResolvedValueOnce('unreachable');
    const { result, rerender } = await renderHook(({ server }: { server: string }) => useServerCheck(server), { initialProps: { server: 'https://old.example.com' } });
    await settle();
    await rerender({ server: 'https://new.example.com' });
    expect(result.current).toBe('checking');
    await act(async () => answerOld('ok'));
    expect(result.current).toBe('checking');
    await settle();
    expect(result.current).toBe('unreachable');
  });

  it('goes back to idle when the address is cleared', async () => {
    mockCheck.mockResolvedValue('ok');
    const { result, rerender } = await renderHook(({ server }: { server: string | null }) => useServerCheck(server), { initialProps: { server: 'https://dots.example.com' as string | null } });
    await settle();
    expect(result.current).toBe('ok');
    await rerender({ server: null });
    expect(result.current).toBe('idle');
  });
});
