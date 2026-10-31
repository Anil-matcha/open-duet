import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed, workingPhase } from './working-status.ts';

test('phase follows what is happening now', () => {
  assert.deepEqual(workingPhase([]), { kind: 'thinking' });
  assert.deepEqual(workingPhase([{ kind: 'tool', state: 'running', name: 'Bash' }]), { kind: 'tool', name: 'Bash' });
  assert.deepEqual(workingPhase([{ kind: 'tool', state: 'done', name: 'Bash' }]), { kind: 'thinking' });
  assert.deepEqual(workingPhase([{ kind: 'tool', state: 'running', name: 'Bash' }, { kind: 'approval', status: 'pending' }]), { kind: 'waiting' });
  assert.deepEqual(workingPhase([{ kind: 'tool', state: 'running', name: 'Old' }, { kind: 'assistant', text: 'x' }]), { kind: 'thinking' });
});

test('elapsed time reads naturally', () => {
  assert.equal(formatElapsed(7.9), '7s');
  assert.equal(formatElapsed(65), '1m 05s');
  assert.equal(formatElapsed(720), '12m 00s');
  assert.equal(formatElapsed(-3), '0s');
});
