import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectOmpModels,
    normalizeOmpDefaultModel,
    normalizeOmpModelCatalog,
    resetOmpModelsCacheForTests,
} from './ompModels';

const CATALOG = [
    { selector: 'openai-codex/gpt-5.6-sol', name: 'GPT 5.6 Sol' },
    { selector: 'kimi-code/k3', name: 'K3' },
];

function fakeRunner(catalog: unknown = { models: CATALOG }) {
    return vi.fn((args: string[]) => {
        if (args[0] === 'models') {
            return Promise.resolve(catalog);
        }
        return Promise.resolve({ value: { default: 'openai-codex/gpt-5.6-sol' } });
    });
}

beforeEach(() => {
    resetOmpModelsCacheForTests();
});

describe('OMP model catalog parsing', () => {
    it('maps selectors and searchable display names while dropping invalid duplicates', () => {
        expect(normalizeOmpModelCatalog({
            models: [
                { selector: 'openai-codex/gpt-5.6-sol', name: 'GPT 5.6 Sol' },
                { selector: 'openai-codex/gpt-5.6-sol', name: 'duplicate' },
                { selector: 'kimi-code/k3', name: 'K3' },
                { selector: '', name: 'empty selector' },
                { name: 'missing selector' },
            ],
        })).toEqual([
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
        expect(() => normalizeOmpModelCatalog({})).toThrow('OMP model catalog response is invalid');
    });

    it('reads and normalizes the configured default model', () => {
        expect(normalizeOmpDefaultModel({ value: { default: '  openai-codex/gpt-5.6-sol:high  ' } }))
            .toBe('openai-codex/gpt-5.6-sol:high');
        expect(normalizeOmpDefaultModel({ value: {} })).toBeNull();
    });
});

describe('OMP model snapshot cache', () => {
    it('fetches the catalog once and serves the cached snapshot inside the TTL', async () => {
        const runOmpJson = fakeRunner();
        const first = await collectOmpModels({ runOmpJson, now: Date.now() });
        expect(first.models.map((model) => model.key)).toEqual(['openai-codex/gpt-5.6-sol', 'kimi-code/k3']);
        expect(first.defaultModel).toBe('openai-codex/gpt-5.6-sol');
        expect(first.refreshing).toBe(false);

        const second = await collectOmpModels({ runOmpJson, now: Date.now() + 10_000 });
        expect(second.models).toEqual(first.models);
        expect(runOmpJson.mock.calls.filter((call) => call[0][0] === 'models')).toHaveLength(1);
    });

    it('starts a refresh after the snapshot TTL expires', async () => {
        const runOmpJson = fakeRunner();
        await collectOmpModels({ runOmpJson, now: Date.now() });

        const refreshed = fakeRunner({ models: [{ selector: 'c/three', name: 'Three' }] });
        const snapshot = await collectOmpModels({ runOmpJson: refreshed, now: Date.now() + 6 * 60_000 });
        expect(snapshot.models.map((model) => model.key)).toEqual(['c/three']);
        expect(refreshed.mock.calls.filter((call) => call[0][0] === 'models')).toHaveLength(1);
    });

    it('refreshes on force while the snapshot is still fresh', async () => {
        const runOmpJson = fakeRunner();
        await collectOmpModels({ runOmpJson, now: Date.now() });

        const forced = fakeRunner({ models: [{ selector: 'd/four', name: 'Four' }] });
        const snapshot = await collectOmpModels({ runOmpJson: forced, force: true, now: Date.now() });
        expect(snapshot.models.map((model) => model.key)).toEqual(['d/four']);
    });

    it('reports refreshing while a slow catalog fetch runs, then serves its result', async () => {
        const slow = Promise.withResolvers<{ models: Array<{ selector: string; name: string }> }>();
        const runOmpJson = vi.fn((args: string[]) => {
            if (args[0] === 'models') {
                return slow.promise;
            }
            return Promise.resolve({ value: { default: 'x/y' } });
        });

        const pending = await collectOmpModels({ runOmpJson, refreshWaitMs: 10 });
        expect(pending.refreshing).toBe(true);
        expect(pending.models).toEqual([]);

        slow.resolve({ models: [{ selector: 'e/five', name: 'Five' }] });
        const settled = await collectOmpModels({ runOmpJson, now: Date.now() });
        expect(settled.refreshing).toBe(false);
        expect(settled.models.map((model) => model.key)).toEqual(['e/five']);
        expect(runOmpJson.mock.calls.filter((call) => call[0][0] === 'models')).toHaveLength(1);
    });

    it('keeps the last good catalog and reports the error when a refresh fails', async () => {
        const runOmpJson = fakeRunner();
        const first = await collectOmpModels({ runOmpJson, now: Date.now() });

        const failing = vi.fn((args: string[]) => (
            args[0] === 'models'
                ? Promise.reject(new Error('catalog unavailable'))
                : Promise.resolve({ value: {} })
        ));
        const snapshot = await collectOmpModels({ runOmpJson: failing, force: true, now: Date.now() });
        expect(snapshot.models).toEqual(first.models);
        expect(snapshot.error).toBe('catalog unavailable');
    });

    it('returns an empty list with the error when no snapshot exists yet', async () => {
        const failing = vi.fn(() => Promise.reject(new Error('omp missing')));
        const snapshot = await collectOmpModels({ runOmpJson: failing, now: Date.now() });
        expect(snapshot.models).toEqual([]);
        expect(snapshot.refreshing).toBe(false);
        expect(snapshot.error).toBe('omp missing');
    });
});
