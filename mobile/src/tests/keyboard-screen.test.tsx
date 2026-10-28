import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { KeyboardScreen } from '@/components/keyboard-screen';

jest.mock('react-native-keyboard-controller', () => {
  const actual = jest.requireActual('react-native-keyboard-controller/jest');
  return { ...actual, useKeyboardState: jest.fn() };
});

const insets = { top: 0, left: 0, right: 0, bottom: 30 };
const open = (isVisible: boolean) => (useKeyboardState as jest.Mock).mockImplementation((select: (s: { isVisible: boolean }) => unknown) => select({ isVisible }));
const bottomRoom = () => Object.assign({}, ...[screen.getByTestId('keyboard-screen').props.style].flat(2).filter(Boolean)).paddingBottom;

describe('KeyboardScreen', () => {
  it('renders what it wraps, even without a safe-area provider', async () => {
    open(false);
    await render(
      <KeyboardScreen>
        <Text>composer</Text>
      </KeyboardScreen>,
    );
    expect(screen.getByText('composer')).toBeTruthy();
    expect(bottomRoom()).toBe(0);
  });

  it('keeps the composer above the bottom system bar while the keyboard is closed', async () => {
    open(false);
    await render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <KeyboardScreen>
          <Text>composer</Text>
        </KeyboardScreen>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(bottomRoom()).toBe(30);
  });

  it('adds no extra room while the keyboard is open, because the keyboard covers that bar', async () => {
    open(true);
    await render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <KeyboardScreen>
          <Text>composer</Text>
        </KeyboardScreen>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(bottomRoom()).toBe(0);
  });
});
