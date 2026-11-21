import { apiSocket } from '@/sync/apiSocket';
import { machineBash } from '@/sync/ops';
import { MMKV } from 'react-native-mmkv';

export type OmpModelOption = {
    key: string;
    name: string;
    description?: string | null;
};

/** Shape served by the `omp-models` machine RPC in happy-cli. */
export type OmpModelsSnapshot = {
    models: OmpModelOption[];
    defaultModel: string | null;
    fetchedAt: number | null;
    refreshing: boolean;
    error: string | null;
};

// The catalog listing (`omp models --json`) takes about 60 s on the machine
// and the server aborts machine RPCs after 30 s, so the daemon answers from a
// cached snapshot and refreshes in the background. The app polls while the
// daemon reports `refreshing` and keeps its own persisted list for the moment
// the phone cannot reach the machine at all.
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_RPC_TIMEOUT_MS = 20_000;
const MODEL_POLL_INTERVAL_MS = 3_000;
const MODEL_REFRESH_WAIT_MS = 150_000;
const CATALOG_STAT_COMMAND = "stat -c '%Y %s' ~/.omp/agent/models.db";

type OmpModelCacheEntry = {
    models: OmpModelOption[];
    fetchedAt: number;
    catalogStamp: string | null;
};

const ompModelStorage = new MMKV({ id: 'omp-model-cache' });
const OMP_MODEL_CACHE_KEY = 'omp-model-cache-v1';
const modelCache = new Map<string, OmpModelCacheEntry>();

function loadPersistedCache(): Record<string, OmpModelCacheEntry> {
    const raw = ompModelStorage.getString(OMP_MODEL_CACHE_KEY);
    if (!raw) {
        return {};
    }
    try {
        return JSON.parse(raw) as Record<string, OmpModelCacheEntry>;
    } catch {
        return {};
    }
}

function persistCacheEntry(machineId: string, entry: OmpModelCacheEntry) {
    const cache = loadPersistedCache();
    cache[machineId] = entry;
    ompModelStorage.set(OMP_MODEL_CACHE_KEY, JSON.stringify(cache));
}

function hydrateCacheEntry(machineId: string): OmpModelCacheEntry | null {
    let entry = modelCache.get(machineId) ?? null;
    if (!entry) {
        const persisted = loadPersistedCache()[machineId];
        if (persisted?.models?.length) {
            entry = persisted;
            modelCache.set(machineId, entry);
        }
    }
    return entry;
}

export function getCachedOmpModels(machineId: string): OmpModelOption[] | null {
    return hydrateCacheEntry(machineId)?.models ?? null;
}

// React Native swaps the global Promise for the `promise` package, which has
// no Promise.withResolvers; use the constructor form there.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function fetchMachineOmpModels(machineId: string, force: boolean): Promise<OmpModelsSnapshot> {
    return withTimeout(
        apiSocket.machineRPC<OmpModelsSnapshot, { force: boolean }>(machineId, 'omp-models', { force }),
        MODEL_RPC_TIMEOUT_MS,
        'OMP model list',
    );
}

function defaultOption(defaultModel: string | null): OmpModelOption {
    return {
        key: 'default',
        name: defaultModel ? `${defaultModel} (default)` : 'default model',
        description: 'Use the OMP default configured on this machine',
    };
}

/**
 * Returns the machine's OMP models. Serves the persisted list while it is
 * fresh, otherwise asks the daemon for its snapshot and, when the daemon is
 * still refreshing the catalog, polls until the refreshed list arrives.
 */
export async function refreshOmpModels(machineId: string): Promise<OmpModelOption[]> {
    const cached = hydrateCacheEntry(machineId);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
        return cached.models;
    }

    const statResult = await machineBash(machineId, CATALOG_STAT_COMMAND, '/');
    const catalogStamp = statResult.success ? statResult.stdout.trim() : null;
    const force = !cached || catalogStamp === null || catalogStamp !== cached.catalogStamp;

    let snapshot: OmpModelsSnapshot;
    try {
        snapshot = await fetchMachineOmpModels(machineId, force);
    } catch (error) {
        if (cached) {
            return cached.models;
        }
        throw error;
    }

    const deadline = Date.now() + MODEL_REFRESH_WAIT_MS;
    while (snapshot.refreshing && Date.now() < deadline) {
        await delay(MODEL_POLL_INTERVAL_MS);
        try {
            snapshot = await fetchMachineOmpModels(machineId, false);
        } catch {
            break;
        }
    }

    if (snapshot.models.length === 0) {
        if (cached) {
            return cached.models;
        }
        throw new Error(snapshot.error ?? 'OMP model list unavailable');
    }

    const models = [defaultOption(snapshot.defaultModel), ...snapshot.models];
    // The listing rewrites the catalog database, so the stamp is read after the
    // refresh to keep the next check from treating the CLI's own write as a
    // catalog change.
    const postFetchStat = await machineBash(machineId, CATALOG_STAT_COMMAND, '/');
    const entry: OmpModelCacheEntry = {
        models,
        fetchedAt: Date.now(),
        catalogStamp: postFetchStat.success ? postFetchStat.stdout.trim() : catalogStamp,
    };
    modelCache.set(machineId, entry);
    persistCacheEntry(machineId, entry);
    return models;
}
