import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

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
