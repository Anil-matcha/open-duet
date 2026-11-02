// The app's typeface is Geist and Geist Mono, the same as the web app. Plain TypeScript with no React Native
// imports; the font files themselves are listed in `font-assets.ts` and loaded once by the root layout.

/** The names the font files are registered under (`font-assets.ts`). */
export const FAMILY = {
  regular: 'Geist_400Regular',
  regularItalic: 'Geist_400Regular_Italic',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  boldItalic: 'Geist_700Bold_Italic',
  mono: 'GeistMono_400Regular',
} as const;

/** Written in a style as `fontFamily: MONO`: Geist Mono once it has loaded, the system monospace until then. */
export const MONO = 'mono';

/** The Geist file for a `fontWeight` and whether the text is italic. Weights in between go to the nearest file below. */
export function familyFor(weight: string | number | undefined, italic: boolean): string {
  const value = weight === 'bold' ? 700 : weight === 'normal' || weight === undefined ? 400 : Number(weight);
  if (value >= 700) return italic ? FAMILY.boldItalic : FAMILY.bold;
  // There are no medium or semibold italics; those stay upright rather than being slanted by the system.
  if (value >= 600) return FAMILY.semibold;
  if (value >= 500) return FAMILY.medium;
  return italic ? FAMILY.regularItalic : FAMILY.regular;
}
