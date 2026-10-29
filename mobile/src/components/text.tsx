import { createContext, useContext } from 'react';
import { Platform, StyleSheet, Text as NativeText, TextInput as NativeTextInput, type StyleProp, type TextInputProps, type TextProps, type TextStyle } from 'react-native';

import { FAMILY, familyFor, MONO } from '@/lib/fonts';

// Text and TextInput that draw in Geist. A custom font has one file per weight, so a style's `fontWeight`
// is turned into the right file here and no screen has to name a font. Every screen imports these two
// instead of React Native's. Until the root layout says the fonts have loaded (or failed to), styles pass
// through unchanged and the system font is used, so the weights still show.
export const FontsLoadedContext = createContext(false);
// True inside another Text: a nested piece keeps its parent's weight unless its own style names one.
const InsideTextContext = createContext(false);

const SYSTEM_MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The style with its `fontWeight` and `fontStyle` replaced by the Geist file that has them. */
export function applyFont(style: StyleProp<TextStyle>, loaded: boolean, nested = false): TextStyle {
  const flat = StyleSheet.flatten(style) ?? {};
  const mono = flat.fontFamily === MONO;
  if (!loaded) return mono ? { ...flat, fontFamily: SYSTEM_MONO } : flat;
  const { fontWeight, fontStyle, ...rest } = flat;
  if (mono) return { ...rest, fontFamily: FAMILY.mono };
  // A font a style names itself is left alone.
  if (rest.fontFamily) return flat;
  // A nested piece that says nothing about weight or slant inherits all of it from its parent.
  if (nested && fontWeight === undefined && fontStyle === undefined) return flat;
  return { ...rest, fontFamily: familyFor(fontWeight, fontStyle === 'italic') };
}

/** Like `applyFont`, for code that sets a style outside a Text (a navigation header). */
export function useFont(style: StyleProp<TextStyle>): TextStyle {
  return applyFont(style, useContext(FontsLoadedContext));
}

export function Text({ style, children, ...props }: TextProps) {
  const loaded = useContext(FontsLoadedContext);
  const nested = useContext(InsideTextContext);
  return (
    <NativeText {...props} style={applyFont(style, loaded, nested)}>
      <InsideTextContext.Provider value>{children}</InsideTextContext.Provider>
    </NativeText>
  );
}

export function TextInput({ style, ...props }: TextInputProps) {
  return <NativeTextInput {...props} style={useFont(style)} />;
}
