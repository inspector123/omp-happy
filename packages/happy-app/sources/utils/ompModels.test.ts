import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({ machineBash: vi.fn() }));

import { machineBash } from '@/sync/ops';
import { getCachedOmpModels, parseOmpDefaultModel, parseOmpModelCatalog, refreshOmpModels } from './ompModels';

const mockedMachineBash = vi.mocked(machineBash);

const CATALOG_MODELS = [
    { selector: 'a/one', name: 'One' },
    { selector: 'b/two', name: 'Two' },
];

function catalogResult(models: Array<{ selector: string; name: string }>) {
    return { success: true, stdout: JSON.stringify({ models }), stderr: '', exitCode: 0 };
}

function rolesResult(defaultModel: string) {
    return { success: true, stdout: JSON.stringify({ value: { default: defaultModel } }), stderr: '', exitCode: 0 };
}

function failedResult(stderr: string) {
    return { success: false, stdout: '', stderr, exitCode: 1 };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockedMachineBash.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

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

describe('OMP model refresh with cache and retries', () => {
    it('caches a successful refresh and serves later calls without refetching', async () => {
        mockedMachineBash.mockImplementation((_machineId, command) => (
            command === 'omp models --json'
                ? Promise.resolve(catalogResult(CATALOG_MODELS))
                : Promise.resolve(rolesResult('x/y'))
        ));

        const models = await refreshOmpModels('machine-cache', '/');
        expect(models.map((model) => model.key)).toEqual(['default', 'a/one', 'b/two']);
        expect(getCachedOmpModels('machine-cache')).toEqual(models);

        mockedMachineBash.mockClear();
        await expect(refreshOmpModels('machine-cache', '/')).resolves.toEqual(models);
        expect(mockedMachineBash).not.toHaveBeenCalled();
    });

    it('retries with a fresh RPC when the first attempt hangs past the timeout', async () => {
        let catalogCalls = 0;
        mockedMachineBash.mockImplementation((_machineId, command) => {
            if (command === 'omp models --json') {
                catalogCalls += 1;
                return catalogCalls === 1
                    ? new Promise<never>(() => {})
                    : Promise.resolve(catalogResult(CATALOG_MODELS));
            }
            return Promise.resolve(rolesResult('x/y'));
        });

        const pending = refreshOmpModels('machine-retry', '/');
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(pending).resolves.toEqual([
            { key: 'default', name: 'x/y (default)', description: 'Use the OMP default configured on this machine' },
            { key: 'a/one', name: 'a/one', description: 'One' },
            { key: 'b/two', name: 'b/two', description: 'Two' },
        ]);
        expect(catalogCalls).toBe(2);
    });

    it('serves stale cached models when a later refresh keeps failing', async () => {
        mockedMachineBash.mockImplementation((_machineId, command) => (
            command === 'omp models --json'
                ? Promise.resolve(catalogResult(CATALOG_MODELS))
                : Promise.resolve(rolesResult('x/y'))
        ));
        const models = await refreshOmpModels('machine-stale', '/');

        await vi.advanceTimersByTimeAsync(61_000);
        mockedMachineBash.mockImplementation(() => Promise.resolve(failedResult('boom')));
        await expect(refreshOmpModels('machine-stale', '/')).resolves.toEqual(models);
    });

    it('throws after exhausting retries when no cache exists', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockedMachineBash.mockImplementation(() => Promise.resolve(failedResult('boom')));

        await expect(refreshOmpModels('machine-none', '/')).rejects.toThrow('boom');
        expect(mockedMachineBash).toHaveBeenCalledTimes(4);
        expect(getCachedOmpModels('machine-none')).toBeNull();
        warn.mockRestore();
    });
});
