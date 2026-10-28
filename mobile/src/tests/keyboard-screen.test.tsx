import { act, render, screen } from '@testing-library/react-native';
import { Keyboard, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { KeyboardScreen, keyboardOffset } from '@/components/keyboard-screen';

describe('KeyboardScreen', () => {
  it('renders what it wraps, even without a safe-area provider', async () => {
    await render(
      <KeyboardScreen>
        <Text>composer</Text>
      </KeyboardScreen>,
    );
    expect(screen.getByText('composer')).toBeTruthy();
  });
});

describe('KeyboardScreen bottom room', () => {
  const insets = { top: 0, left: 0, right: 0, bottom: 30 };
  const screenWith = () => (
    <SafeAreaInsetsContext.Provider value={insets}>
      <KeyboardScreen>
        <Text>composer</Text>
      </KeyboardScreen>
    </SafeAreaInsetsContext.Provider>
  );
  const bottomRoom = () => {
    return Object.assign({}, ...[screen.getByTestId('keyboard-screen').props.style].flat(2).filter(Boolean)).paddingBottom;
  };

  it('keeps the composer above the bottom system bar while the keyboard is closed', async () => {
    await render(screenWith());
    expect(bottomRoom()).toBe(30);
  });

  it('adds no extra room while the keyboard is open, because the keyboard covers that bar', async () => {
    const listeners: Record<string, () => void> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, fn: () => void) => {
      listeners[name] = fn;
      return { remove: () => undefined };
    }) as never);
    await render(screenWith());
    await act(async () => listeners.keyboardWillShow());
    expect(bottomRoom()).toBe(0);
    await act(async () => listeners.keyboardWillHide());
    expect(bottomRoom()).toBe(30);
    jest.restoreAllMocks();
  });
});

describe('keyboardOffset', () => {
  it('lowers the offset by the bottom bar on Android, so the composer clears the keyboard', () => {
    expect(keyboardOffset(80, 'android', 24)).toBe(56);
    expect(keyboardOffset(0, 'android', 24)).toBe(-24);
  });

  it('uses the measured offset as it is on iOS, whatever the inset', () => {
    expect(keyboardOffset(80, 'ios', 34)).toBe(80);
  });

  it('does nothing extra when there is no bottom bar', () => {
    expect(keyboardOffset(80, 'android', 0)).toBe(80);
  });
});
