import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { Markdown } from '@/components/markdown';
import { TranscriptRow } from '@/components/transcript-row';

import { contrast, dark, light, paletteFor, useStyles, type Palette } from '@/lib/theme';

let mockScheme: 'light' | 'dark' | null = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));

// Text must reach 4.5:1 on what it sits on, in both looks.
const PAIRS: [keyof Palette, keyof Palette][] = [
  ['text', 'background'],
  ['text', 'surface'],
  ['text', 'surfaceStrong'],
  ['text', 'bubbleUser'],
  ['muted', 'bubbleUser'],
  ['text', 'warnBackground'],
  ['muted', 'background'],
  ['muted', 'surface'],
  ['accentText', 'background'],
  ['accentText', 'surface'],
  ['accentText', 'surfaceStrong'],
  ['danger', 'background'],
  ['success', 'background'],
  ['danger', 'warnBackground'],
  ['notice', 'background'],
  ['warnText', 'warnBackground'],
  ['onAccent', 'accent'],
  ['onAccent', 'dangerFill'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s palette', (_name, palette) => {
  it.each(PAIRS)('%s on %s is readable', (foreground, background) => {
    expect(contrast(palette[foreground], palette[background])).toBeGreaterThanOrEqual(4.5);
  });

  it('has only #rrggbb colors', () => {
    for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('contrast', () => {
  it('knows black on white from grey on grey', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#808080')).toBeLessThan(1.2);
  });
});

describe('paletteFor', () => {
  it('uses the dark look only when the phone says dark', () => {
    expect(paletteFor('dark')).toBe(dark);
    expect(paletteFor('light')).toBe(light);
    expect(paletteFor(null)).toBe(light);
  });
});

const create = (p: Palette) => ({ color: p.text, backgroundColor: p.background });
function Probe() {
  const style = useStyles(create);
  return <Text style={style}>probe</Text>;
}

describe('useStyles', () => {
  it('follows the phone setting', async () => {
    mockScheme = 'dark';
    const view = await render(<Probe />);
    expect(screen.getByText('probe').props.style).toEqual({ color: dark.text, backgroundColor: dark.background });
    mockScheme = 'light';
    await view.rerender(<Probe />);
    expect(screen.getByText('probe').props.style).toEqual({ color: light.text, backgroundColor: light.background });
  });
});

describe('screens use the palette', () => {
  const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;
  // Nested text inherits its color, so look for it on the nearest ancestor that sets one.
  const inheritedColor = (node: { props: { style?: unknown }; parent: unknown }) => {
    let current: { props: { style?: unknown }; parent: unknown } | null = node;
    while (current) {
      const color = flat(current).color;
      if (color) return color;
      current = current.parent as typeof current;
    }
    return undefined;
  };
  const approval = { kind: 'approval' as const, key: 'a', turnId: 1, approvalId: 'x', tool: 'Bash', approvalKind: 'tool', summary: 'ls', input: {}, status: 'pending' as const };

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('the approval card in the %s look', async (scheme, palette) => {
    mockScheme = scheme;
    await render(<ApprovalCard item={approval} waiting={1} onAnswer={jest.fn()} />);
    expect(flat(screen.getByLabelText('Approval needed'))).toMatchObject({ backgroundColor: palette.warnBackground, borderColor: palette.warnBorder });
    expect(flat(screen.getByText('ls'))).toMatchObject({ color: palette.text });
  });

  it('the message box and the send button', async () => {
    mockScheme = 'dark';
    await render(<Composer running={false} onSend={jest.fn()} onStop={jest.fn()} />);
    expect(flat(screen.getByLabelText('Message'))).toMatchObject({ color: dark.text, borderColor: dark.inputBorder });
    expect(screen.getByLabelText('Message').props.placeholderTextColor).toBe(dark.muted);
  });

  it('a conversation bubble and a Markdown answer', async () => {
    mockScheme = 'dark';
    await render(<TranscriptRow row={{ kind: 'assistant', key: 'k', turnId: 1, text: 'hello', incomplete: false }} />);
    expect(inheritedColor(screen.getByText('hello'))).toBe(dark.text);
    await render(<Markdown text="`code`" />);
    expect(flat(screen.getByText('code'))).toMatchObject({ backgroundColor: dark.surfaceStrong });
  });
});
