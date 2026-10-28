import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { Composer } from '@/components/composer';
import { TranscriptRow } from '@/components/transcript-row';
import { createApi } from '@/lib/api';
import { attachmentProblem, buildMultipart, readAttachments, type Attachment } from '@/lib/attachments';
import { applyEvent, emptyTranscript } from '@/lib/transcript';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildMultipart', () => {
  it('wraps the bytes in one file part, exactly', () => {
    const { body, contentType } = buildMultipart('file', 'notes.txt', 'text/plain', new TextEncoder().encode('hello'));
    const boundary = /boundary=(.+)$/.exec(contentType)![1];
    expect(text(body)).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
  });

  it('keeps binary bytes untouched', () => {
    const bytes = Uint8Array.from([0, 255, 13, 10, 45, 45, 128]);
    const { body } = buildMultipart('file', 'a.png', 'image/png', bytes);
    expect(Array.from(body).join(',')).toContain(Array.from(bytes).join(','));
  });

  it('cannot be broken out of by a file name', () => {
    const { body } = buildMultipart('file', 'a"\r\nX-Evil: 1.txt', 'text/plain', new Uint8Array());
    expect(text(body)).not.toContain('\r\nX-Evil');
    expect(text(body)).toContain('filename="a___X-Evil: 1.txt"');
  });
});

describe('attachmentProblem', () => {
  it('names a file that is too large, by kind', () => {
    expect(attachmentProblem('a.png', 'image/png', 11 * 1024 * 1024)).toMatch(/10 MB/);
    expect(attachmentProblem('a.txt', 'text/plain', 2 * 1024 * 1024)).toMatch(/1 MB/);
  });

  it('lets a file with an unknown size through for the server to decide', () => {
    expect(attachmentProblem('a.txt', 'text/plain', undefined)).toBeNull();
    expect(attachmentProblem('a.png', 'image/png', 1000)).toBeNull();
  });
});

describe('readAttachments', () => {
  it('keeps what it can read and drops the rest', () => {
    expect(readAttachments([{ id: 'a'.repeat(32), name: 'x.png', mime: 'image/png', bytes: 4, kind: 'image' }, null, { id: 5 }, { id: 'b', name: 'n.txt' }])).toEqual([
      { id: 'a'.repeat(32), name: 'x.png', mime: 'image/png', bytes: 4, kind: 'image' },
      { id: 'b', name: 'n.txt', mime: '', bytes: 0, kind: 'text' },
    ]);
    expect(readAttachments(undefined)).toEqual([]);
  });
});

describe('transcript', () => {
  it('shows what was attached to a message', () => {
    const state = applyEvent(emptyTranscript(), {
      seq: 1,
      type: 'turn.started',
      turn_id: 1,
      data: { prompt_text: 'look', attachments: [{ id: 'c'.repeat(32), name: 'cat.png', mime: 'image/png', bytes: 9, kind: 'image' }] },
    });
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'look', attachments: [{ name: 'cat.png', kind: 'image' }] });
  });

  it('is fine with a message that has none', () => {
    const state = applyEvent(emptyTranscript(), { seq: 1, type: 'turn.started', turn_id: 1, data: { prompt_text: 'hi' } });
    expect(state.items[0]).toMatchObject({ attachments: [] });
  });
});

describe('api', () => {
  const session = { server: 'https://dots.example.com', token: 'ods_t' };

  it('uploads one file as multipart with the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: 201, ok: true, json: async () => ({ id: 'd'.repeat(32), name: 'a.txt', mime: 'text/plain', bytes: 2, kind: 'text' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const saved = await createApi(session, { fetchImpl: impl }).uploadAttachment(7, { name: 'a.txt', mime: 'text/plain', bytes: new TextEncoder().encode('hi') });
    expect(saved.id).toBe('d'.repeat(32));
    expect(calls[0].url).toBe('https://dots.example.com/api/v1/threads/7/attachments');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ods_t');
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0].init.body).toBeInstanceOf(Uint8Array);
  });

  it('sends attachment ids with a turn only when there are some', async () => {
    const bodies: string[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { status: 202, ok: true, json: async () => ({ id: 1 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const api = createApi(session, { fetchImpl: impl });
    await api.sendTurn(1, 'plain');
    await api.sendTurn(1, 'with', ['x']);
    expect(JSON.parse(bodies[0])).toEqual({ prompt_text: 'plain' });
    expect(JSON.parse(bodies[1])).toEqual({ prompt_text: 'with', attachment_ids: ['x'] });
  });

  it('gives where an image can be loaded, with the token', () => {
    expect(createApi(session).attachmentSource(7, 'e'.repeat(32))).toEqual({
      uri: `https://dots.example.com/api/v1/threads/7/attachments/${'e'.repeat(32)}`,
      headers: { Authorization: 'Bearer ods_t' },
    });
  });
});

describe('Composer attachments', () => {
  const file = (id: string, name: string): Attachment => ({ id, name, mime: 'text/plain', bytes: 3, kind: 'text' });
  let alert: jest.SpyInstance;

  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => alert.mockRestore());

  const choose = async (label: 'Photo' | 'File') => {
    await fireEvent.press(screen.getByLabelText('Attach'));
    const buttons = alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((button) => button.text === label)!.onPress!();
    });
  };

  it('has no attach button unless the screen can attach', async () => {
    await render(<Composer running={false} onSend={jest.fn()} onStop={jest.fn()} />);
    expect(screen.queryByLabelText('Attach')).toBeNull();
  });

  it('attaches a picked file, sends its id with the message, then clears it', async () => {
    const onAttach = jest.fn().mockResolvedValue([file('f1', 'notes.txt')]);
    const onSend = jest.fn().mockResolvedValue(true);
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} onAttach={onAttach} />);
    await choose('File');
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(onAttach).toHaveBeenCalledWith('file', 8);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'read this');
    await fireEvent.press(screen.getByLabelText('Send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('read this', ['f1']));
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
  });

  it('keeps the files when sending fails', async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} onAttach={jest.fn().mockResolvedValue([file('f1', 'notes.txt')])} />);
    await choose('File');
    await screen.findByText('notes.txt');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'x');
    await fireEvent.press(screen.getByLabelText('Send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });

  it('removes a file before sending', async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} onAttach={jest.fn().mockResolvedValue([file('f1', 'a.txt'), file('f2', 'b.txt')])} />);
    await choose('File');
    await screen.findByText('a.txt');
    await fireEvent.press(screen.getByLabelText('Remove a.txt'));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'x');
    await fireEvent.press(screen.getByLabelText('Send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('x', ['f2']));
  });

  it('cannot send while a file is still uploading', async () => {
    let finish: (files: Attachment[]) => void = () => undefined;
    const onSend = jest.fn().mockResolvedValue(true);
    const onAttach = jest.fn(() => new Promise<Attachment[]>((resolve) => (finish = resolve)));
    await render(<Composer running={false} onSend={onSend} onStop={jest.fn()} onAttach={onAttach} />);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'x');
    await choose('Photo');
    await fireEvent.press(screen.getByLabelText('Send'));
    expect(onSend).not.toHaveBeenCalled();
    finish([file('f1', 'p.png')]);
    await screen.findByText('p.png');
  });
});

describe('TranscriptRow attachments', () => {
  const row = (attachments: Attachment[]) => ({ kind: 'user' as const, key: 'u', turnId: 1, text: 'look', attachments });

  it('shows an image through the source it is given, and a text file as a chip', async () => {
    const source = jest.fn((id: string) => ({ uri: `https://x/${id}`, headers: { Authorization: 'Bearer t' } }));
    await render(
      <TranscriptRow
        row={row([
          { id: 'i1', name: 'cat.png', mime: 'image/png', bytes: 1, kind: 'image' },
          { id: 't1', name: 'a.txt', mime: 'text/plain', bytes: 1, kind: 'text' },
        ])}
        attachmentSource={source}
      />,
    );
    expect(screen.getByLabelText('cat.png').props.source).toEqual({ uri: 'https://x/i1', headers: { Authorization: 'Bearer t' } });
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('falls back to a chip when no image source is available', async () => {
    await render(<TranscriptRow row={row([{ id: 'i1', name: 'cat.png', mime: 'image/png', bytes: 1, kind: 'image' }])} />);
    expect(screen.getByText('cat.png')).toBeTruthy();
  });
});
