import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({ machineBash: vi.fn() }));

vi.mock('react-native-mmkv', () => {
    const stores = new Map<string, Map<string, string>>();
    class MMKV {
        private store: Map<string, string>;
        constructor(options?: { id?: string }) {
            const id = options?.id ?? 'default';
            if (!stores.has(id)) {
                stores.set(id, new Map());
            }
            this.store = stores.get(id)!;
        }
        getString(key: string) {
            return this.store.get(key);
        }
        set(key: string, value: string) {
            this.store.set(key, value);
        }
    }
    return { MMKV };
});

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

/** Routes the mocked machine RPC by command: `stat` stamp (null = stat fails), catalog fetch, roles. */
function mockMachineBashHandlers(handlers: {
    stat?: string | null;
    catalog?: () => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>;
}) {
    mockedMachineBash.mockImplementation((_machineId, command) => {
        if (command.startsWith('stat -c')) {
            return Promise.resolve(handlers.stat === undefined || handlers.stat === null
                ? failedResult('stat failed')
                : { success: true, stdout: handlers.stat, stderr: '', exitCode: 0 });
        }
        if (command === 'omp models --json') {
            return handlers.catalog ? handlers.catalog() : Promise.resolve(catalogResult(CATALOG_MODELS));
        }
        return Promise.resolve(rolesResult('x/y'));
    });
}

function ompModelsCallCount() {
    return mockedMachineBash.mock.calls.filter((call) => call[1] === 'omp models --json').length;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockedMachineBash.mockReset();
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

describe('OMP model refresh with persisted cache and catalog stamp', () => {
    it('fetches once, persists, and serves later calls without invoking omp', async () => {
        mockMachineBashHandlers({ stat: '1793047988 7675904' });

        const models = await refreshOmpModels('machine-cache', '/');
        expect(models.map((model) => model.key)).toEqual(['default', 'a/one', 'b/two']);
        expect(getCachedOmpModels('machine-cache')).toEqual(models);
        expect(ompModelsCallCount()).toBe(1);

        await expect(refreshOmpModels('machine-cache', '/')).resolves.toEqual(models);
        expect(ompModelsCallCount()).toBe(1);
    });

    it('serves the persisted list without invoking omp while the catalog is unchanged', async () => {
        mockMachineBashHandlers({ stat: '1793047988 7675904' });
        const models = await refreshOmpModels('machine-unchanged', '/');

        await vi.advanceTimersByTimeAsync(61_000);
        await expect(refreshOmpModels('machine-unchanged', '/')).resolves.toEqual(models);
        expect(ompModelsCallCount()).toBe(1);
    });

    it('re-runs the CLI when the catalog stamp changed', async () => {
        mockMachineBashHandlers({ stat: '1793047988 7675904' });
        await refreshOmpModels('machine-refreshed', '/');

        await vi.advanceTimersByTimeAsync(61_000);
        mockMachineBashHandlers({
            stat: '1793054466 7675905',
            catalog: () => Promise.resolve(catalogResult([{ selector: 'c/three', name: 'Three' }])),
        });
        const models = await refreshOmpModels('machine-refreshed', '/');
        expect(models.map((model) => model.key)).toEqual(['default', 'c/three']);
        expect(ompModelsCallCount()).toBe(2);
    });

    it('retries with a fresh RPC when the first attempt hangs past the timeout', async () => {
        let catalogCalls = 0;
        mockMachineBashHandlers({
            stat: '1793047988 7675904',
            catalog: () => {
                catalogCalls += 1;
                return catalogCalls === 1
                    ? new Promise<never>(() => {})
                    : Promise.resolve(catalogResult(CATALOG_MODELS));
            },
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
        mockMachineBashHandlers({ stat: '1793047988 7675904' });
        const models = await refreshOmpModels('machine-stale', '/');

        await vi.advanceTimersByTimeAsync(61_000);
        mockMachineBashHandlers({
            stat: '1793054466 7675905',
            catalog: () => Promise.resolve(failedResult('boom')),
        });
        await expect(refreshOmpModels('machine-stale', '/')).resolves.toEqual(models);
    });

    it('throws after exhausting retries when no cache exists', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockMachineBashHandlers({
            stat: '1793047988 7675904',
            catalog: () => Promise.resolve(failedResult('boom')),
        });

        await expect(refreshOmpModels('machine-none', '/')).rejects.toThrow('boom');
        expect(ompModelsCallCount()).toBe(2);
        expect(getCachedOmpModels('machine-none')).toBeNull();
        warn.mockRestore();
    });
});
