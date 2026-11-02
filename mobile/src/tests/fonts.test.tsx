import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text as NativeText } from 'react-native';

import { applyFont, FontsLoadedContext, Text, TextInput } from '@/components/text';
import { FAMILY, familyFor, MONO } from '@/lib/fonts';
import { FONT_FILES } from '@/lib/font-assets';

const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe('familyFor', () => {
  it('picks the Geist file for a weight, upright or italic', () => {
    expect(familyFor(undefined, false)).toBe(FAMILY.regular);
    expect(familyFor('normal', false)).toBe(FAMILY.regular);
    expect(familyFor('400', false)).toBe(FAMILY.regular);
    expect(familyFor('500', false)).toBe(FAMILY.medium);
    expect(familyFor('600', false)).toBe(FAMILY.semibold);
    expect(familyFor('700', false)).toBe(FAMILY.bold);
    expect(familyFor('bold', false)).toBe(FAMILY.bold);
    expect(familyFor('900', false)).toBe(FAMILY.bold);
    expect(familyFor('300', false)).toBe(FAMILY.regular);
    expect(familyFor(600, false)).toBe(FAMILY.semibold);
    expect(familyFor('400', true)).toBe(FAMILY.regularItalic);
    expect(familyFor('bold', true)).toBe(FAMILY.boldItalic);
    // No medium or semibold italic file exists.
    expect(familyFor('600', true)).toBe(FAMILY.semibold);
  });

  it('has a file for every family the app can ask for', () => {
    for (const name of Object.values(FAMILY)) expect(FONT_FILES).toHaveProperty(name);
    expect(Object.keys(FONT_FILES).sort()).toEqual(Object.values(FAMILY).sort());
  });
});

describe('applyFont', () => {
  it('leaves a style alone until the fonts have loaded, apart from the monospace choice', () => {
    expect(applyFont({ fontWeight: '700', color: 'red' }, false)).toEqual({ fontWeight: '700', color: 'red' });
    expect(applyFont({ fontFamily: MONO }, false).fontFamily).not.toBe(MONO);
  });

  it('turns the weight and slant into the Geist file and drops them from the style', () => {
    expect(applyFont({ fontWeight: '700', color: 'red', fontSize: 14 }, true)).toEqual({ fontFamily: FAMILY.bold, color: 'red', fontSize: 14 });
    expect(applyFont({ fontStyle: 'italic' }, true)).toEqual({ fontFamily: FAMILY.regularItalic });
    expect(applyFont([{ fontWeight: '600' }, { color: 'red' }], true)).toEqual({ fontFamily: FAMILY.semibold, color: 'red' });
    expect(applyFont(undefined, true)).toEqual({ fontFamily: FAMILY.regular });
  });

  it('uses Geist Mono for the monospace choice and keeps a font a style names itself', () => {
    expect(applyFont({ fontFamily: MONO, fontSize: 13 }, true)).toEqual({ fontFamily: FAMILY.mono, fontSize: 13 });
    expect(applyFont({ fontFamily: 'Custom', fontWeight: '700' }, true)).toEqual({ fontFamily: 'Custom', fontWeight: '700' });
  });

  it('lets a nested piece inherit unless it names its own weight or slant', () => {
    expect(applyFont({ color: 'red' }, true, true)).toEqual({ color: 'red' });
    expect(applyFont({ fontWeight: '700' }, true, true)).toEqual({ fontFamily: FAMILY.bold });
  });
});

describe('Text and TextInput', () => {
  it('draw in the system font until the fonts have loaded', async () => {
    await render(<Text style={{ fontWeight: '700' }}>hello</Text>);
    expect(flat(screen.getByText('hello'))).toEqual({ fontWeight: '700' });
  });

  it('draw in Geist once they have, and a nested piece keeps its parent\'s weight', async () => {
    await render(
      <FontsLoadedContext.Provider value>
        <Text style={{ fontWeight: '700' }}>
          parent <Text>plain piece</Text> <Text style={{ fontStyle: 'italic' }}>slanted</Text>
        </Text>
        <TextInput accessibilityLabel="box" style={{ fontSize: 16 }} />
        <NativeText>untouched</NativeText>
      </FontsLoadedContext.Provider>,
    );
    expect(flat(screen.getByText(/parent/))).toEqual({ fontFamily: FAMILY.bold });
    expect(flat(screen.getByText('plain piece'))).toEqual({});
    expect(flat(screen.getByText('slanted'))).toEqual({ fontFamily: FAMILY.regularItalic });
    expect(flat(screen.getByLabelText('box'))).toMatchObject({ fontFamily: FAMILY.regular, fontSize: 16 });
    expect(screen.getByText('untouched').props.style).toBeUndefined();
  });
});
