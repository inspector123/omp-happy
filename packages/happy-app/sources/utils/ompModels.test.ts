import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({ machineBash: vi.fn() }));

import { parseOmpDefaultModel, parseOmpModelCatalog } from './ompModels';

describe('OMP model catalog parsing', () => {
    it('maps selectors and searchable display names while dropping invalid duplicates', () => {
        expect(parseOmpModelCatalog(JSON.stringify({
            models: [
                { selector: 'openai-codex/gpt-5.6-sol', name: 'GPT 5.6 Sol' },
                { selector: 'openai-codex/gpt-5.6-sol', name: 'duplicate' },
                { selector: 'kimi-code/k3', name: 'K3' },
                { selector: '', name: 'empty selector' },
                { name: 'missing selector' },
            ],
        }))).toEqual([
            {
                key: 'openai-codex/gpt-5.6-sol',
                name: 'openai-codex/gpt-5.6-sol',
                description: 'GPT 5.6 Sol',
            },
            {
                key: 'kimi-code/k3',
                name: 'kimi-code/k3',
                description: 'K3',
            },
        ]);
    });

    it('rejects a response without a model array', () => {
        expect(() => parseOmpModelCatalog('{}')).toThrow('OMP model catalog response is invalid');
    });

    it('reads and normalizes the configured default model', () => {
        expect(parseOmpDefaultModel(JSON.stringify({
            value: { default: '  openai-codex/gpt-5.6-sol:high  ' },
        }))).toBe('openai-codex/gpt-5.6-sol:high');
        expect(parseOmpDefaultModel(JSON.stringify({ value: {} }))).toBeNull();
    });
});
