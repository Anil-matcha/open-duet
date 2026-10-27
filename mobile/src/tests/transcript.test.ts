import type { ThreadEvent } from '@/lib/api';
import { applyEvent, applyEvents, emptyTranscript, pendingApprovals } from '@/lib/transcript';

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, turn_id: number | null = 1): ThreadEvent => ({ seq, type, turn_id, data });
const typing = (text: string, mode = 'append'): ThreadEvent => ({ type: 'text.delta', turn_id: 1, data: { text, mode } });

describe('transcript', () => {
  it('shows the message, the answer and how far the stream has got', () => {
    const t = applyEvents(emptyTranscript(), [ev(1, 'turn.started', { prompt_text: 'hello' }), ev(2, 'assistant.message', { text: 'hi there' }), ev(3, 'turn.completed')]);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(t.items[0]).toMatchObject({ text: 'hello' });
    expect(t.items[1]).toMatchObject({ text: 'hi there', incomplete: false });
    expect(t.lastSeq).toBe(3);
    expect(t.runningTurnId).toBeNull();
  });

  it('tracks the running turn', () => {
    const t = applyEvent(emptyTranscript(), ev(1, 'turn.started', { prompt_text: 'x' }, 7));
    expect(t.runningTurnId).toBe(7);
  });

  it('never applies an event twice, so a replay after a reconnect shows nothing again', () => {
    const events = [ev(1, 'turn.started', { prompt_text: 'a' }), ev(2, 'assistant.message', { text: 'b' })];
    const once = applyEvents(emptyTranscript(), events);
    const twice = applyEvents(once, events);
    expect(twice.items).toHaveLength(2);
    expect(twice).toBe(once);
  });

  it('builds the typing preview and replaces it with the stored message', () => {
    let t = applyEvent(emptyTranscript(), ev(1, 'turn.started', { prompt_text: 'x' }));
    t = applyEvent(t, typing('Hel'));
    t = applyEvent(t, typing('lo'));
    expect(t.typing).toBe('Hello');
    t = applyEvent(t, typing('Hello wor', 'replace'));
    expect(t.typing).toBe('Hello wor');
    t = applyEvent(t, ev(2, 'assistant.message', { text: 'Hello world' }));
    expect(t.typing).toBeNull();
    expect(t.items[1]).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  });

  it('shows a tool step as one line that finishes', () => {
    let t = applyEvent(emptyTranscript(), ev(1, 'tool.started', { call_id: 'c1', name: 'Bash', summary: 'ls -la' }));
    expect(t.items[0]).toMatchObject({ kind: 'tool', state: 'running', summary: 'ls -la' });
    t = applyEvent(t, ev(2, 'tool.completed', { call_id: 'c1', ok: true }));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ state: 'done' });
    t = applyEvent(t, ev(3, 'tool.started', { call_id: 'c2', name: 'Bash', summary: 'false' }));
    t = applyEvent(t, ev(4, 'tool.completed', { call_id: 'c2', ok: false }));
    expect(t.items[1]).toMatchObject({ state: 'error' });
  });

  it('still shows a tool completion whose start was never seen', () => {
    const t = applyEvent(emptyTranscript(), ev(5, 'tool.completed', { call_id: 'zz', ok: true }));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: 'tool', state: 'done' });
  });

  it('shows an approval waiting, then how it was answered', () => {
    let t = applyEvent(emptyTranscript(), ev(1, 'approval.requested', { approval_id: 'a1', tool: 'Bash', summary: 'rm -rf build', kind: 'command' }));
    expect(t.items[0]).toMatchObject({ kind: 'approval', status: 'pending', summary: 'rm -rf build' });
    t = applyEvent(t, ev(2, 'approval.resolved', { approval_id: 'a1', status: 'allow' }));
    expect(t.items[0]).toMatchObject({ status: 'allowed' });
  });

  it('keeps what an approval would run, so the card can show it', () => {
    const t = applyEvent(
      emptyTranscript(),
      ev(1, 'approval.requested', { approval_id: 'a1', tool: 'Bash', summary: 'git status', kind: 'command', input: { command: 'git status', description: 'check' } }),
    );
    expect(t.items[0]).toMatchObject({ approvalKind: 'command', input: { command: 'git status', description: 'check' } });
  });

  it('lists the approvals still waiting, oldest first', () => {
    const t = applyEvents(emptyTranscript(), [
      ev(1, 'approval.requested', { approval_id: 'a1', tool: 'Bash', summary: 'one' }),
      ev(2, 'approval.requested', { approval_id: 'a2', tool: 'Write', summary: 'two' }),
      ev(3, 'approval.resolved', { approval_id: 'a1', status: 'deny' }),
    ]);
    expect(pendingApprovals(t.items).map((a) => a.approvalId)).toEqual(['a2']);
  });

  it('closes open approvals and tool steps when the turn ends', () => {
    const t = applyEvents(emptyTranscript(), [
      ev(1, 'turn.started', { prompt_text: 'x' }),
      ev(2, 'tool.started', { call_id: 'c', name: 'Bash', summary: 'sleep 99' }),
      ev(3, 'approval.requested', { approval_id: 'a', tool: 'Bash', summary: 'sudo' }),
      ev(4, 'turn.cancelled'),
    ]);
    expect(t.items.find((i) => i.kind === 'tool')).toMatchObject({ state: 'stopped' });
    expect(t.items.find((i) => i.kind === 'approval')).toMatchObject({ status: 'cancelled' });
    expect(t.items[t.items.length - 1]).toMatchObject({ kind: 'turn_end', status: 'cancelled' });
    expect(t.runningTurnId).toBeNull();
  });

  it('says why a turn failed', () => {
    const t = applyEvents(emptyTranscript(), [ev(1, 'turn.started', { prompt_text: 'x' }), ev(2, 'turn.failed', { error: 'quota used up' })]);
    expect(t.items[t.items.length - 1]).toMatchObject({ kind: 'turn_end', status: 'failed', error: 'quota used up' });
  });

  it('skips metadata events and shows one muted row for an unknown type', () => {
    const t = applyEvents(emptyTranscript(), [ev(1, 'memory.recalled'), ev(2, 'skill.used'), ev(3, 'context.compacted'), ev(4, 'something.new'), ev(5, 'turn.started', { prompt_text: 'x' })]);
    expect(t.items.map((i) => i.kind)).toEqual(['unsupported', 'user']);
    expect(t.items[0]).toMatchObject({ type: 'something.new' });
    expect(t.lastSeq).toBe(5);
  });

  it('survives events with missing or odd data', () => {
    const odd = { seq: 1, type: 'assistant.message', data: null } as unknown as ThreadEvent;
    const t = applyEvent(emptyTranscript(), odd);
    expect(t.items[0]).toMatchObject({ kind: 'assistant', text: '' });
  });
});
