import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { KeyboardScreen } from '@/components/keyboard-screen';

describe('KeyboardScreen', () => {
  it('renders what it wraps', async () => {
    await render(
      <KeyboardScreen>
        <Text>composer</Text>
      </KeyboardScreen>,
    );
    expect(screen.getByText('composer')).toBeTruthy();
  });
});
