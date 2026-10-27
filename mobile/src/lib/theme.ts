// Colors for the light and dark looks. The app follows the phone's setting; there is no switch of its own.
// Every screen takes its colors from here, so a pair that reads well in one look is checked once in
// `theme.test.ts` (text on its background must reach a 4.5:1 contrast).

import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

export type Palette = {
  /** Screens. */
  background: string;
  /** Assistant bubbles, chips and the like. */
  surface: string;
  /** Code blocks and inline code, a step stronger than `surface`. */
  surfaceStrong: string;
  text: string;
  muted: string;
  border: string;
  inputBorder: string;
  /** Fill of primary buttons and the person's own bubbles; `onAccent` is the text on it. */
  accent: string;
  onAccent: string;
  /** Links, outlines and text buttons on a screen. */
  accentText: string;
  /** Red text and outlines. `dangerFill` is a red button with `onAccent` text on it. */
  danger: string;
  dangerFill: string;
  notice: string;
  /** The approval card and the reconnecting banner. */
  warnBackground: string;
  warnBorder: string;
  warnText: string;
  quoteBar: string;
};

export const light: Palette = {
  background: '#ffffff',
  surface: '#eceff1',
  surfaceStrong: '#dfe4e8',
  text: '#111111',
  muted: '#555555',
  border: '#bbbbbb',
  inputBorder: '#999999',
  accent: '#0a7ea4',
  onAccent: '#ffffff',
  accentText: '#0a6c8e',
  danger: '#b91c1c',
  dangerFill: '#b91c1c',
  notice: '#b45309',
  warnBackground: '#fff8e1',
  warnBorder: '#d9a400',
  warnText: '#6b5200',
  quoteBar: '#9aa5ab',
};

export const dark: Palette = {
  background: '#101417',
  surface: '#1f272c',
  surfaceStrong: '#2c363c',
  text: '#e8eaed',
  muted: '#a3adb3',
  border: '#3a444a',
  inputBorder: '#5b676e',
  accent: '#0a7ea4',
  onAccent: '#ffffff',
  accentText: '#4cc2e8',
  danger: '#f87171',
  dangerFill: '#b91c1c',
  notice: '#f0a35e',
  warnBackground: '#2e2608',
  warnBorder: '#d9a400',
  warnText: '#f2c94c',
  quoteBar: '#6b777e',
};

export function paletteFor(scheme: string | null | undefined): Palette {
  return scheme === 'dark' ? dark : light;
}

export function useTheme(): Palette {
  return paletteFor(useColorScheme());
}

/** Styles built from the current palette. Pass a function defined once at module level. */
export function useStyles<T>(create: (palette: Palette) => T): T {
  const palette = useTheme();
  return useMemo(() => create(palette), [create, palette]);
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
