import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { ApprovalCard } from '@/components/approval-card';
import { approvalFields, PREVIEW_CHARS, previewValue } from '@/lib/approval-text';
import type { TranscriptItem } from '@/lib/transcript';

type Approval = Extract<TranscriptItem, { kind: 'approval' }>;

const approval = (input: Record<string, unknown> = { command: 'rm -rf build' }): Approval => ({
  kind: 'approval',
  key: 'e1',
  turnId: 1,
  approvalId: 'ap1',
  tool: 'Bash',
  approvalKind: 'command',
  summary: 'Delete the build folder',
  input,
  status: 'pending',
});

describe('approvalFields', () => {
  it('lists every input, with objects as readable JSON', () => {
    expect(approvalFields({ command: 'ls', env: { A: '1' }, force: true })).toEqual([
      { name: 'command', value: 'ls' },
      { name: 'env', value: '{\n  "A": "1"\n}' },
      { name: 'force', value: 'true' },
    ]);
  });

  it('previews only long values', () => {
    expect(previewValue('short')).toEqual({ text: 'short', cut: false });
    const long = 'x'.repeat(PREVIEW_CHARS + 50);
    expect(previewValue(long)).toEqual({ text: 'x'.repeat(PREVIEW_CHARS), cut: true });
  });
});

describe('ApprovalCard', () => {
  it('scrolls expanded input separately from the approval buttons', async () => {
    const long = 'command output\n'.repeat(100) + 'LAST LINE';
    const onAnswer = jest.fn().mockResolvedValue(true);
    await render(<ApprovalCard item={approval({ content: long })} waiting={1} onAnswer={onAnswer} />);
    const details = within(screen.getByLabelText('Approval details'));
    await fireEvent.press(details.getByRole('button', { name: 'Show all' }));
    expect(details.getByText(/LAST LINE/)).toBeTruthy();
    // The controls stay outside the scrolling body even when the input is expanded.
    expect(details.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(details.queryByRole('button', { name: 'Deny' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenCalledWith('deny');
  });

  it('shows the tool, the summary and the exact input', async () => {
    await render(<ApprovalCard item={approval()} waiting={1} onAnswer={jest.fn()} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('Delete the build folder')).toBeTruthy();
    expect(screen.getByText('command')).toBeTruthy();
    expect(screen.getByText('rm -rf build')).toBeTruthy();
    expect(screen.getByText(/will not run until you allow it/)).toBeTruthy();
  });

  it('says how many are waiting', async () => {
    await render(<ApprovalCard item={approval()} waiting={3} onAnswer={jest.fn()} />);
    expect(screen.getByText(/1 of 3 waiting/)).toBeTruthy();
  });

  it('cuts a long value and shows all of it on request', async () => {
    const long = 'a'.repeat(PREVIEW_CHARS) + 'THE-END';
    await render(<ApprovalCard item={approval({ content: long })} waiting={1} onAnswer={jest.fn()} />);
    expect(screen.queryByText(/THE-END/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText(/THE-END/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText(/THE-END/)).toBeNull();
  });

  it('sends Allow, then waits for the server to report it', async () => {
    const onAnswer = jest.fn().mockResolvedValue(true);
    await render(<ApprovalCard item={approval()} waiting={1} onAnswer={onAnswer} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Allow' }));
    expect(onAnswer).toHaveBeenCalledWith('allow');
    expect(await screen.findByText(/Allowed\. Waiting for your server/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('sends Deny', async () => {
    const onAnswer = jest.fn().mockResolvedValue(true);
    await render(<ApprovalCard item={approval()} waiting={1} onAnswer={onAnswer} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenCalledWith('deny');
    expect(await screen.findByText(/Denied\. Waiting for your server/)).toBeTruthy();
  });

  it('keeps both buttons when the answer failed, so it can be tried again', async () => {
    const onAnswer = jest.fn().mockResolvedValue(false);
    await render(<ApprovalCard item={approval()} waiting={1} onAnswer={onAnswer} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  it('ignores a second tap while the first answer is in flight', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onAnswer = jest.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    await render(<ApprovalCard item={approval()} waiting={1} onAnswer={onAnswer} />);
    // Not awaited: the first press only settles once the answer does, and that is held back here.
    const first = fireEvent.press(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
    expect(await screen.findByText(/Allowed\./)).toBeTruthy();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});
