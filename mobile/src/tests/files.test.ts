import { ApiError, createApi, describeFileError } from '@/lib/api';
import { baseName, folderTitle, formatBytes, parentPath, readFolder, readPreview, safeFileName } from '@/lib/files';

describe('readFolder', () => {
  it('keeps the entries the server describes and drops malformed ones', () => {
    const folder = readFolder({
      path: 'docs',
      truncated: true,
      entries: [{ name: 'a.md', path: 'docs/a.md', type: 'file', bytes: 12 }, { name: 'sub', path: 'docs/sub', type: 'dir', bytes: null }, { path: 'x' }, null, 'junk'],
    });
    expect(folder.path).toBe('docs');
    expect(folder.truncated).toBe(true);
    expect(folder.entries.map((entry) => entry.name)).toEqual(['a.md', 'sub']);
  });

  it('is empty for anything that is not a listing', () => {
    expect(readFolder(null)).toEqual({ path: '', entries: [], truncated: false });
    expect(readFolder({ entries: 'no' }).entries).toEqual([]);
  });
});

describe('readPreview', () => {
  it('reads a text preview', () => {
    expect(readPreview({ path: 'a/b.txt', name: 'b.txt', bytes: 5, mime: 'text/plain', kind: 'text', text: 'hello', truncated: false })).toMatchObject({ kind: 'text', text: 'hello' });
  });

  it('falls back to a binary file named after its path', () => {
    expect(readPreview({ path: 'a/b.bin' })).toMatchObject({ name: 'b.bin', kind: 'binary', text: null, bytes: 0 });
  });
});

describe('paths and sizes', () => {
  it('finds the parent folder and a title', () => {
    expect(parentPath('a/b/c.txt')).toBe('a/b');
    expect(parentPath('c.txt')).toBe('');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(folderTitle('')).toBe('Files');
    expect(folderTitle('docs/notes')).toBe('notes');
  });

  it('formats sizes', () => {
    expect(formatBytes(300)).toBe('300 B');
    expect(formatBytes(12 * 1024)).toBe('12 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('makes a name safe to save under', () => {
    expect(safeFileName('../../etc/pass wd.txt')).toBe('_.._etc_pass_wd.txt');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('')).toBe('file');
  });
});

describe('the file calls', () => {
  const session = { server: 'https://dots.example.com', token: 'ods_t' };
  const reply = (body: unknown) => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { api: createApi(session, { fetchImpl: impl }), calls };
  };

  it('lists a folder with its path encoded', async () => {
    const { api, calls } = reply({ path: 'my docs', entries: [] });
    await api.listFiles(4, 'my docs');
    expect(calls).toEqual(['https://dots.example.com/api/v1/threads/4/files?path=my%20docs']);
  });

  it('previews a file', async () => {
    const { api, calls } = reply({ path: 'a.txt', kind: 'text', text: 'hi' });
    expect((await api.previewFile(4, 'a.txt')).text).toBe('hi');
    expect(calls[0]).toBe('https://dots.example.com/api/v1/threads/4/files/content?path=a.txt');
  });

  it('gives where to fetch an image or a download, with the token', () => {
    const { api } = reply({});
    expect(api.fileSource(4, 'a b.png', 'raw')).toEqual({ uri: 'https://dots.example.com/api/v1/threads/4/files/raw?path=a%20b.png', headers: { Authorization: 'Bearer ods_t' } });
    expect(api.fileSource(4, 'a.zip', 'download').uri).toContain('/files/download?path=a.zip');
  });
});

describe('describeFileError', () => {
  it('tells a phone paired without file access how to get it', () => {
    expect(describeFileError(new ApiError(403, 'scope_denied', 'This device needs the files scope for that.'))).toMatch(/Chat and files/);
  });

  it('uses the server wording for a reason it gives', () => {
    expect(describeFileError(new ApiError(404, 'no_workspace', "This conversation has no workspace."))).toBe('This conversation has no workspace.');
    expect(describeFileError(new ApiError(403, 'secret_file', 'Secret files are never shown.'))).toBe('Secret files are never shown.');
  });

  it('falls back to the usual wording for the rest', () => {
    expect(describeFileError(new ApiError(0, 'unreachable', ''))).toMatch(/Could not reach/);
    expect(describeFileError(new ApiError(401, 'session_invalid', ''))).toMatch(/signed this phone out/);
  });
});
