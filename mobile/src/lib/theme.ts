// Colors for the light and dark looks. The app follows the phone's setting; there is no switch of its own.
// Every screen takes its colors from here, so a pair that reads well in one look is checked once in
// `theme.test.tsx` (text on its background must reach a 4.5:1 contrast).
//
// The values are the web app's own tokens (frontend/app/globals.css), so the phone and the web look alike.
// `theme-drift.test.ts` reads that file and fails when a value here no longer matches its token; change
// a color in globals.css first, then here. `warnBackground` is the one phone-only color: the web has no
// tinted background for a warning.

import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

export type Palette = {
  /** Screens. */
  background: string;
  /** Assistant bubbles, chips and the like. */
  surface: string;
  /** Code blocks and inline code (the web's code background, set into a bubble). */
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
  background: '#f7f6f3',
  surface: '#e9e6df',
  surfaceStrong: '#f0ede6',
  text: '#1c1b19',
  muted: '#5b574f',
  border: '#dcd8cf',
  inputBorder: '#6b665d',
  accent: '#3151c8',
  onAccent: '#ffffff',
  accentText: '#3151c8',
  danger: '#b92b27',
  dangerFill: '#b92b27',
  notice: '#8f5200',
  warnBackground: '#fff8e1',
  warnBorder: '#8f5200',
  warnText: '#8f5200',
  quoteBar: '#6b665d',
};

export const dark: Palette = {
  background: '#0e0e10',
  surface: '#2a2a2e',
  surfaceStrong: '#19191c',
  text: '#ececee',
  muted: '#a3a3ab',
  border: '#2f2f35',
  inputBorder: '#9595a0',
  accent: '#7b95ff',
  onAccent: '#0b0d14',
  accentText: '#7b95ff',
  danger: '#ff7b7b',
  dangerFill: '#ff7b7b',
  notice: '#e5a03a',
  warnBackground: '#2e2608',
  warnBorder: '#e5a03a',
  warnText: '#e5a03a',
  quoteBar: '#9595a0',
};

/**
 * Corner radii, in points. `field` (inputs, buttons, chips) and `card` (bubbles, cards, blocks) are the web's
 * `--radius-field` and `--radius-card`, 0.625rem and 0.875rem at 16 points to the rem; `theme-drift.test.ts`
 * checks them. `round` makes a circle of any small square.
 */
export const radius = { field: 10, card: 14, round: 999 } as const;

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
