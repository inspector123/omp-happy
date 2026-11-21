import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/ops', () => ({ machineBash: vi.fn() }));

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { machineRPC: vi.fn() },
}));

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

import { apiSocket } from '@/sync/apiSocket';
import { machineBash } from '@/sync/ops';
import { getCachedOmpModels, refreshOmpModels, type OmpModelOption } from './ompModels';

const mockedMachineBash = vi.mocked(machineBash);
const mockedMachineRPC = vi.mocked(apiSocket.machineRPC);

const CATALOG: OmpModelOption[] = [
    { key: 'a/one', name: 'a/one', description: 'One' },
    { key: 'b/two', name: 'b/two', description: 'Two' },
];

const DEFAULT_OPTION: OmpModelOption = {
    key: 'default',
    name: 'a/one (default)',
    description: 'Use the OMP default configured on this machine',
};

function snapshot(overrides: Partial<{
    models: OmpModelOption[];
    defaultModel: string | null;
    fetchedAt: number;
    refreshing: boolean;
    error: string | null;
}> = {}) {
    return {
        models: CATALOG,
        defaultModel: 'a/one',
        fetchedAt: Date.now(),
        refreshing: false,
        error: null,
        ...overrides,
    };
}

function mockStamp(sequence: string[]) {
    let calls = 0;
    mockedMachineBash.mockImplementation(() => {
        const stamp = sequence[Math.min(calls, sequence.length - 1)];
        calls += 1;
        return Promise.resolve({ success: true, stdout: stamp, stderr: '', exitCode: 0 });
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockedMachineBash.mockReset();
    mockedMachineRPC.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('OMP model refresh through the daemon snapshot', () => {
    it('returns the catalog with the default option and serves the persisted list inside the TTL', async () => {
        mockStamp(['1793047988 7675904']);
        mockedMachineRPC.mockResolvedValue(snapshot());

        const models = await refreshOmpModels('machine-cache');
        expect(models).toEqual([
            DEFAULT_OPTION,
            { key: 'a/one', name: 'a/one', description: 'One' },
            { key: 'b/two', name: 'b/two', description: 'Two' },
        ]);
        expect(getCachedOmpModels('machine-cache')).toEqual(models);
        expect(mockedMachineRPC).toHaveBeenCalledTimes(1);

        await expect(refreshOmpModels('machine-cache')).resolves.toEqual(models);
        expect(mockedMachineRPC).toHaveBeenCalledTimes(1);
    });

    it('forces a refresh only when the catalog stamp changed since the last fetch', async () => {
        mockStamp(['1793047988 7675904', '1793054466 7675905', '1793054466 7675905']);
        mockedMachineRPC.mockResolvedValue(snapshot());

        await refreshOmpModels('machine-force');
        expect(mockedMachineRPC.mock.calls.map((call) => call[2])).toEqual([{ force: true }]);

        await vi.advanceTimersByTimeAsync(61_000);
        await refreshOmpModels('machine-force');
        expect(mockedMachineRPC.mock.calls.map((call) => call[2])).toEqual([{ force: true }, { force: false }]);

        await vi.advanceTimersByTimeAsync(61_000);
        await refreshOmpModels('machine-force');
        expect(mockedMachineRPC.mock.calls.map((call) => call[2])).toEqual([{ force: true }, { force: false }, { force: false }]);
    });

    it('polls while the daemon refreshes and returns the refreshed list', async () => {
        mockStamp(['1793047988 7675904']);
        mockedMachineRPC
            .mockResolvedValueOnce(snapshot({ models: [], defaultModel: null, refreshing: true }))
            .mockResolvedValueOnce(snapshot({
                models: [{ key: 'e/five', name: 'e/five', description: null }],
                defaultModel: 'x/y',
            }));

        const pending = refreshOmpModels('machine-poll');
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(pending).resolves.toEqual([
            { key: 'default', name: 'x/y (default)', description: 'Use the OMP default configured on this machine' },
            { key: 'e/five', name: 'e/five', description: null },
        ]);
        expect(mockedMachineRPC).toHaveBeenCalledTimes(2);
    });

    it('serves the persisted list when the daemon call fails', async () => {
        mockStamp(['1793047988 7675904']);
        mockedMachineRPC.mockResolvedValueOnce(snapshot());
        const cached = await refreshOmpModels('machine-offline');

        await vi.advanceTimersByTimeAsync(61_000);
        mockedMachineRPC.mockRejectedValueOnce(new Error('RPC method not available'));
        await expect(refreshOmpModels('machine-offline')).resolves.toEqual(cached);
    });

    it('throws when the daemon has no list and nothing is cached', async () => {
        mockStamp(['1793047988 7675904']);
        mockedMachineRPC.mockResolvedValueOnce(snapshot({ models: [], error: 'catalog unavailable' }));

        await expect(refreshOmpModels('machine-empty')).rejects.toThrow('catalog unavailable');
        expect(getCachedOmpModels('machine-empty')).toBeNull();
    });
});
