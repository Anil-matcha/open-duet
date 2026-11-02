import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { columnWidths, Markdown } from '@/components/markdown';
import { isSafeLink, parseInline, parseMarkdown, splitTableRow, type Block } from '@/lib/markdown';

const plain = (cells: { text: string }[][]) => cells.map((spans) => spans.map((span) => span.text).join(''));
type Table = Extract<Block, { type: 'table' }>;

describe('parseInline', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** *c* `d`')).toEqual([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }]);
  });

  it('nests italic inside bold', () => {
    expect(parseInline('**a *b* c**')).toEqual([{ text: 'a ', bold: true }, { text: 'b', bold: true, italic: true }, { text: ' c', bold: true }]);
  });

  it('leaves snake_case and lone stars alone', () => {
    expect(parseInline('my_var_name and 2 * 3 * 4')).toEqual([{ text: 'my_var_name and 2 * 3 * 4' }]);
  });

  it('does not format inside code', () => {
    expect(parseInline('`**x**`')).toEqual([{ text: '**x**', code: true }]);
  });

  it('keeps web links and drops the link from anything else', () => {
    expect(parseInline('[docs](https://example.com/a)')).toEqual([{ text: 'docs', href: 'https://example.com/a' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ text: '[x](javascript:alert(1))' }]);
    expect(isSafeLink('intent://x')).toBe(false);
    expect(isSafeLink('file:///etc/passwd')).toBe(false);
    expect(isSafeLink('HTTPS://example.com')).toBe(true);
  });
});

describe('parseMarkdown', () => {
  it('splits headings, paragraphs and lists', () => {
    const blocks = parseMarkdown('# Title\n\nSome text\nmore\n\n- one\n- two\n\n1. a\n2. b');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list']);
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect((blocks[3] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('keeps a code block as written, including blank lines and markdown characters', () => {
    const blocks = parseMarkdown('```ts\nconst a = **1**;\n\nb\n```\nafter');
    expect(blocks[0]).toEqual({ type: 'code', text: 'const a = **1**;\n\nb' });
    expect(blocks[1].type).toBe('paragraph');
  });

  it('accepts a code block that was never closed', () => {
    expect(parseMarkdown('```\nrunning')[0]).toEqual({ type: 'code', text: 'running' });
  });

  it('reads quotes and indented list continuations', () => {
    const blocks = parseMarkdown('> a\n> b\n\n- item\n  more');
    expect(blocks[0].type).toBe('quote');
    expect((blocks[1] as { items: { text: string }[][] }).items[0].map((s) => s.text).join('')).toBe('item\nmore');
  });

  it('handles empty and Windows line ends', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2);
  });

  it('reads a table with its alignment and formatted cells', () => {
    const blocks = parseMarkdown('Before\n\n| Item | Owner | Due |\n|:--|:-:|--:|\n| **Plan** | Sam | 1 Nov |\n| Ship | `a\\|b` | 8 Nov |\n\nAfter');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    const table = blocks[1] as Table;
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(plain(table.header)).toEqual(['Item', 'Owner', 'Due']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toEqual([{ text: 'Plan', bold: true }]);
    expect(plain(table.rows[1])).toEqual(['Ship', 'a|b', '8 Nov']);
  });

  it('reads a table without outer pipes and pads or cuts uneven rows', () => {
    const table = parseMarkdown('a | b\n--- | ---\n1 |\n1 | 2 | 3')[0] as Table;
    expect(table.type).toBe('table');
    expect(table.rows.map(plain)).toEqual([['1', ''], ['1', '2']]);
  });

  it('keeps a pipe inside backticks in its cell', () => {
    expect(splitTableRow('| `a | b` | c |')).toEqual(['`a | b`', 'c']);
    expect(splitTableRow('a \\| b | c')).toEqual(['a | b', 'c']);
  });

  it('does not take other text for a table', () => {
    expect(parseMarkdown('a | b\nno rule here')[0].type).toBe('paragraph');
    expect(parseMarkdown('a | b | c\n--- | ---')[0].type).toBe('paragraph');
    expect(parseMarkdown('Use a | b\n\n---')[0].type).toBe('paragraph');
    expect(parseMarkdown('```\n| a | b |\n|---|---|\n```')[0].type).toBe('code');
  });

  it('ends a table at a blank line or a line without a pipe', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\nplain text');
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
    expect((blocks[0] as Table).rows).toHaveLength(1);
  });
});

describe('columnWidths', () => {
  const cell = (text: string) => [{ text }];
  it('sizes columns from their longest cell within limits and grows with the text size', () => {
    const header = [[...cell('A')], [...cell('Task')]];
    const rows = [[cell('x'), cell('a very long description of the task that goes on and on and on and on')]];
    expect(columnWidths(header, rows, 1)).toEqual([72, 240]);
    expect(columnWidths(header, rows, 2)).toEqual([144, 480]);
    expect(columnWidths(header, rows, 0.8)[0]).toBe(72);
  });
});

describe('Markdown', () => {
  let open: jest.SpyInstance;
  beforeEach(() => {
    open = jest.spyOn(Linking, 'openURL').mockResolvedValue();
  });
  afterEach(() => open.mockRestore());

  it('shows the text without the markers', async () => {
    await render(<Markdown text={'## Hello\n\n**bold** and `code`\n\n- item'} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('item')).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('opens a web link outside the app when tapped', async () => {
    await render(<Markdown text="see [docs](https://example.com/a)" />);
    await fireEvent.press(screen.getByText('docs'));
    expect(open).toHaveBeenCalledWith('https://example.com/a');
  });

  it('shows a table as cells without the pipes and separators', async () => {
    await render(<Markdown text={'| Item | Owner |\n|---|---|\n| Plan | **Sam** |\n| Ship | Lee |'} />);
    for (const cell of ['Item', 'Owner', 'Plan', 'Sam', 'Ship', 'Lee']) expect(screen.getByText(cell)).toBeTruthy();
    expect(screen.queryByText(/\|/)).toBeNull();
    expect(screen.queryByText(/---/)).toBeNull();
  });

  it('does not make an unsafe link tappable', async () => {
    await render(<Markdown text="[x](javascript:alert(1))" />);
    await fireEvent.press(screen.getByText(/\[x\]/));
    expect(open).not.toHaveBeenCalled();
  });
});
