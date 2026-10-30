import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ApprovalCard } from '@/components/approval-card';
import { Composer } from '@/components/composer';
import { ConversationTitle } from '@/components/conversation-title';
import { JumpToLatest } from '@/components/jump-to-latest';
import { touch } from '@/lib/theme';

const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, number | undefined>;
// A style gives a control its size with `height`/`width` or with `minHeight`/`minWidth`.
const tall = (style: Record<string, number | undefined>) => Math.max(style.height ?? 0, style.minHeight ?? 0);
const wide = (style: Record<string, number | undefined>) => Math.max(style.width ?? 0, style.minWidth ?? 0);

const approval = { kind: 'approval' as const, key: 'a', turnId: 1, approvalId: 'x', tool: 'Write', approvalKind: 'tool', summary: 'a.txt', input: {}, status: 'pending' as const };

describe('touch targets', () => {
  it('are at least 44 points for the message box buttons', async () => {
    await render(<Composer running={false} onSend={jest.fn()} onStop={jest.fn()} onAttach={jest.fn()} />);
    expect(tall(flat(screen.getByLabelText('Attach')))).toBeGreaterThanOrEqual(touch.min);
    expect(wide(flat(screen.getByLabelText('Attach')))).toBeGreaterThanOrEqual(touch.min);
    expect(tall(flat(screen.getByLabelText('Send')))).toBeGreaterThanOrEqual(touch.min);
    expect(tall(flat(screen.getByLabelText('Message')))).toBeGreaterThanOrEqual(touch.min);
  });

  it('are at least 44 points for Stop while an answer runs', async () => {
    await render(<Composer running onSend={jest.fn()} onStop={jest.fn()} />);
    expect(tall(flat(screen.getByLabelText('Stop')))).toBeGreaterThanOrEqual(touch.min);
  });

  it('are at least 44 points for Allow and Deny', async () => {
    await render(<ApprovalCard item={approval} waiting={1} onAnswer={jest.fn()} />);
    expect(tall(flat(screen.getByLabelText('Allow')))).toBeGreaterThanOrEqual(touch.min);
    expect(tall(flat(screen.getByLabelText('Deny')))).toBeGreaterThanOrEqual(touch.min);
  });

  it('are at least 44 points for the jump to latest button', async () => {
    await render(<JumpToLatest onPress={jest.fn()} />);
    const style = flat(screen.getByLabelText('Jump to latest'));
    expect(tall(style)).toBeGreaterThanOrEqual(touch.min);
    expect(wide(style)).toBeGreaterThanOrEqual(touch.min);
  });
});

describe('ConversationTitle', () => {
  it('shows the title and the agent, and reads them as one heading', async () => {
    await render(<ConversationTitle title="Weekly notes" agentId={3} agentName="Scout" />);
    expect(screen.getByText('Weekly notes')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
    expect(screen.getByLabelText('Weekly notes, Scout')).toBeTruthy();
  });

  it('shows the title alone for a plain chat', async () => {
    await render(<ConversationTitle title="New conversation" agentId={null} agentName={null} />);
    expect(screen.getByLabelText('New conversation')).toBeTruthy();
    expect(screen.queryByText('Scout')).toBeNull();
  });
});
