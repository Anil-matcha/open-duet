import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { Avatar } from '@/components/avatar';
import { IDENTITY_COLORS, IDENTITY_COUNT, identityColor, identityIndex, initialOf, ON_IDENTITY } from '@/lib/identity';
import { contrast } from '@/lib/theme';

const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe('identity', () => {
  it('gives an agent the same colour every time, inside the palette', () => {
    for (const id of [1, 2, 3, 99, 123456, '7']) {
      const index = identityIndex(id);
      expect(index).toBe(identityIndex(id));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(IDENTITY_COUNT);
    }
    expect(identityIndex(7)).toBe(identityIndex('7'));
    expect(identityColor(7)).toBe(IDENTITY_COLORS[identityIndex(7)]);
  });

  it('does not give neighbouring ids all one colour', () => {
    expect(new Set(Array.from({ length: 30 }, (_, i) => identityIndex(i + 1))).size).toBeGreaterThanOrEqual(6);
  });

  it('keeps text readable on every agent colour', () => {
    for (const color of IDENTITY_COLORS) expect(contrast(ON_IDENTITY, color)).toBeGreaterThanOrEqual(4.5);
  });

  it('takes the first letter or digit of a name', () => {
    expect(initialOf('scout')).toBe('S');
    expect(initialOf('  ✨ mira')).toBe('M');
    expect(initialOf('émile')).toBe('É');
    expect(initialOf('42 things')).toBe('4');
    expect(initialOf('')).toBe('?');
    expect(initialOf(null)).toBe('?');
    expect(initialOf('---')).toBe('?');
  });
});

describe('Avatar', () => {
  it('shows the first letter on the agent colour', async () => {
    await render(<Avatar agentId={3} name="scout" />);
    // The avatar is hidden from a screen reader, so the query has to ask for hidden elements.
    const letter = screen.getByText('S', { includeHiddenElements: true });
    expect(flat(letter)).toMatchObject({ color: ON_IDENTITY });
    expect(flat(letter.parent!)).toMatchObject({ backgroundColor: identityColor(3) });
  });

  it('shows a chat glyph, not a letter, when there is no agent', async () => {
    await render(<Avatar agentId={null} name="ignored" />);
    expect(screen.queryByText(/./, { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('icon-message-square', { includeHiddenElements: true })).toBeTruthy();
  });

  it('is hidden from a screen reader, because the name is written beside it', async () => {
    await render(<Avatar agentId={3} name="scout" />);
    expect(screen.getByText('S', { includeHiddenElements: true }).parent!.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
