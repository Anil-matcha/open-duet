import { engineLabel, engineProblem, findEngine, modelLabel, readEngines } from '@/lib/engines';

const claude = {
  id: 'claude',
  label: 'Claude Code',
  available: true,
  reason: null,
  models: [
    { id: 'opus', label: 'Opus', default: false },
    { id: 'sonnet', label: 'Sonnet', default: true },
  ],
  default_model: 'sonnet',
  custom_models: false,
  capabilities: { computers: true, tools: true },
  limit: null,
  version: '1.2.3',
};

describe('readEngines', () => {
  it('reads what the editor needs and ignores the rest', () => {
    const [engine] = readEngines([claude]);
    expect(engine).toEqual({
      id: 'claude',
      label: 'Claude Code',
      available: true,
      reason: null,
      models: [
        { id: 'opus', label: 'Opus', isDefault: false },
        { id: 'sonnet', label: 'Sonnet', isDefault: true },
      ],
      defaultModel: 'sonnet',
      customModels: false,
      computers: true,
      limit: null,
    });
  });

  it('drops malformed entries and tolerates a body that is not a list', () => {
    expect(readEngines(null)).toEqual([]);
    expect(readEngines({})).toEqual([]);
    expect(readEngines([null, 5, { label: 'no id' }, { id: 'x', models: [{ label: 'no id' }, null, { id: 'm' }] }])).toEqual([
      { id: 'x', label: 'x', available: false, reason: null, models: [{ id: 'm', label: 'm', isDefault: false }], defaultModel: null, customModels: false, computers: false, limit: null },
    ]);
  });

  it('carries a usage limit message', () => {
    expect(readEngines([{ ...claude, limit: { kind: 'usage_limit', message: 'Resets at 5pm' } }])[0].limit).toBe('Resets at 5pm');
  });
});

describe('labels', () => {
  const engines = readEngines([claude, { id: 'custom', label: 'Custom', available: true, custom_models: true, models: [] }]);

  it('names an engine, or shows the id of one the server no longer lists', () => {
    expect(engineLabel(engines, 'claude')).toBe('Claude Code');
    expect(engineLabel(engines, 'gone')).toBe('gone');
    expect(findEngine(engines, 'gone')).toBeUndefined();
  });

  it('describes the model choice as the web does', () => {
    expect(modelLabel(findEngine(engines, 'claude'), null)).toBe('Engine default (Sonnet)');
    expect(modelLabel(findEngine(engines, 'claude'), 'opus')).toBe('Opus');
    expect(modelLabel(findEngine(engines, 'claude'), 'old-model')).toBe('old-model (saved; unavailable)');
    expect(modelLabel(findEngine(engines, 'custom'), 'my-model')).toBe('my-model');
    expect(modelLabel(undefined, null)).toBe('Engine default');
  });

  it('says why an engine cannot be chosen', () => {
    expect(engineProblem(engines[0])).toBeNull();
    expect(engineProblem({ ...engines[0], available: false, reason: null })).toBe('Needs setup');
    expect(engineProblem({ ...engines[0], available: false, reason: 'Not signed in' })).toBe('Not signed in');
    expect(engineProblem({ ...engines[0], limit: 'Resets at 5pm' })).toBe('Resets at 5pm');
  });
});
