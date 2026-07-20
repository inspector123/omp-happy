import { describe, expect, it, vi } from 'vitest';

import { persistOmpDefaultModel } from './ompModelConfig';

describe('persistOmpDefaultModel', () => {
  it('updates only the default role and preserves every other model role', async () => {
    const runConfigCommand = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        key: 'modelRoles',
        value: {
          advisor: 'openai-codex/gpt-5.5',
          task: 'openai-codex/gpt-5.6-luna:low',
          default: 'zlocal/local',
        },
      }))
      .mockResolvedValueOnce('[ok]');

    await persistOmpDefaultModel('openai-codex/gpt-5.6-sol', runConfigCommand);

    expect(runConfigCommand).toHaveBeenNthCalledWith(1, ['config', 'get', 'modelRoles', '--json']);
    expect(runConfigCommand).toHaveBeenNthCalledWith(2, [
      'config',
      'set',
      'modelRoles',
      JSON.stringify({
        advisor: 'openai-codex/gpt-5.5',
        task: 'openai-codex/gpt-5.6-luna:low',
        default: 'openai-codex/gpt-5.6-sol',
      }),
    ]);
  });

  it('does not rewrite config when the selected model is already the default', async () => {
    const runConfigCommand = vi.fn().mockResolvedValue(JSON.stringify({
      key: 'modelRoles',
      value: { default: 'openai-codex/gpt-5.6-sol' },
    }));

    await persistOmpDefaultModel('openai-codex/gpt-5.6-sol', runConfigCommand);

    expect(runConfigCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed model role data instead of replacing the config', async () => {
    const runConfigCommand = vi.fn().mockResolvedValue(JSON.stringify({
      key: 'modelRoles',
      value: ['zlocal/local'],
    }));

    await expect(persistOmpDefaultModel('openai-codex/gpt-5.6-sol', runConfigCommand))
      .rejects.toThrow('OMP modelRoles config is not a string record');
    expect(runConfigCommand).toHaveBeenCalledTimes(1);
  });
});
