import { dark, light, radius, type Palette } from '@/lib/theme';

// `fs` and `path` run under Jest, but this TypeScript project has no Node types (only Jest's): describe what is used.
declare const __dirname: string;
const { readFileSync } = jest.requireActual<{ readFileSync(path: string, encoding: string): string }>('fs');
const { resolve } = jest.requireActual<{ resolve(...parts: string[]): string }>('path');

// The phone's colors are the web app's tokens. This reads the web stylesheet and fails when a color in
// `lib/theme.ts` no longer matches the token it is taken from (or the other way round).
const GLOBALS = resolve(__dirname, '../../../frontend/app/globals.css');

/** Which web token each phone color comes from. */
const FROM_WEB: Record<Exclude<keyof Palette, 'warnBackground'>, string> = {
  background: 'bg-app',
  surface: 'bg-hover',
  surfaceStrong: 'code-bg',
  text: 'ink',
  muted: 'ink-muted',
  border: 'line',
  inputBorder: 'ink-faint',
  accent: 'accent',
  onAccent: 'accent-fg',
  accentText: 'accent',
  danger: 'danger',
  dangerFill: 'danger',
  notice: 'warning',
  warnBorder: 'warning',
  warnText: 'warning',
  quoteBar: 'ink-faint',
};

/** The custom properties declared in the first block whose selector contains `selector`. */
function tokens(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector} in globals.css`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const found: Record<string, string> = {};
  for (const match of source.slice(open + 1, close).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) found[match[1]] = match[2].trim().toLowerCase();
  return found;
}

const css = readFileSync(GLOBALS, 'utf8').replace(/\r\n/g, '\n');

describe.each([
  ['light', light, ':root[data-theme="light"]'],
  ['dark', dark, ':root[data-theme="dark"]'],
] as const)('the %s palette against the web tokens', (_name, palette, selector) => {
  const web = tokens(css, selector);

  it.each(Object.entries(FROM_WEB))('%s is the web token --%s', (key, token) => {
    expect(web[token]).toBeDefined();
    expect(palette[key as keyof Palette]).toBe(web[token]);
  });

  it('names where every color comes from, except the one that is the phone\'s own', () => {
    expect(Object.keys(palette).sort()).toEqual([...Object.keys(FROM_WEB), 'warnBackground'].sort());
  });
});

describe('the corner radii against the web tokens', () => {
  // The web writes them in rem; a rem is 16 points.
  const points = (name: string) => {
    const match = new RegExp(String.raw`--radius-${name}\s*:\s*([\d.]+)rem`).exec(css);
    if (!match) throw new Error(`--radius-${name} is not declared in rem in globals.css`);
    return Number(match[1]) * 16;
  };

  it('are the web field and card radii', () => {
    expect(radius.field).toBe(points('field'));
    expect(radius.card).toBe(points('card'));
  });
});
