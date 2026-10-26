import { machineBash } from '@/sync/ops';
import { MMKV } from 'react-native-mmkv';

export type OmpModelOption = {
    key: string;
    name: string;
    description?: string | null;
};

type OmpCatalogModel = {
    selector?: unknown;
    name?: unknown;
};

type OmpModelRolesResponse = {
    value?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOmpModelCatalog(raw: string): OmpModelOption[] {
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
        throw new Error('OMP model catalog response is invalid');
    }

    const seen = new Set<string>();
    const models: OmpModelOption[] = [];
    for (const candidate of payload.models as OmpCatalogModel[]) {
        if (!isRecord(candidate) || typeof candidate.selector !== 'string') {
            continue;
        }
        const selector = candidate.selector.trim();
        if (!selector || seen.has(selector)) {
            continue;
        }
        seen.add(selector);

        const displayName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        models.push({
            key: selector,
            name: selector,
            description: displayName && displayName !== selector ? displayName : null,
        });
    }
    return models;
}

export function parseOmpDefaultModel(raw: string): string | null {
    const payload: unknown = JSON.parse(raw) as OmpModelRolesResponse;
    if (!isRecord(payload) || !isRecord(payload.value)) {
        return null;
    }
    const configuredDefault = payload.value.default;
    return typeof configuredDefault === 'string' && configuredDefault.trim()
        ? configuredDefault.trim()
        : null;
}

export async function listOmpModels(machineId: string, cwd: string): Promise<OmpModelOption[]> {
    const [catalogResult, defaultsResult] = await Promise.all([
        machineBash(machineId, 'omp models --json', cwd),
        machineBash(machineId, 'omp config get modelRoles --json', cwd),
    ]);

    if (!catalogResult.success) {
        throw new Error(catalogResult.stderr || 'Failed to load OMP models');
    }

    const configuredDefault = defaultsResult.success
        ? parseOmpDefaultModel(defaultsResult.stdout)
        : null;
    const defaultOption: OmpModelOption = {
        key: 'default',
        name: configuredDefault ? `${configuredDefault} (default)` : 'default model',
        description: 'Use the OMP default configured on this machine',
    };

    return [defaultOption, ...parseOmpModelCatalog(catalogResult.stdout)];
}

// The OMP catalog is refreshed on this machine by the user running
// `omp models refresh`; listing through the CLI (`omp models --json`) is slow
// (it re-checks providers) and the phone's socket to the server reconnects
// every few tens of seconds, so an ack lost in a reconnect window leaves the
// socket.io ack promise pending forever. The app therefore persists the last
// fetched list and only re-runs the CLI when the catalog file's stat stamp
// changed — a plain `stat` RPC, no omp invocation.
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const MODEL_FETCH_MAX_ATTEMPTS = 2;
const MODEL_CACHE_TTL_MS = 60_000;
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    const { promise: timed, resolve, reject } = Promise.withResolvers<T>();
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
    return timed;
}

async function fetchOmpModelsWithRetry(
    machineId: string,
    cwd: string,
    catalogStamp: string | null,
): Promise<OmpModelOption[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MODEL_FETCH_MAX_ATTEMPTS; attempt++) {
        try {
            const models = await withTimeout(listOmpModels(machineId, cwd), MODEL_FETCH_TIMEOUT_MS, 'OMP model list');
            const entry: OmpModelCacheEntry = { models, fetchedAt: Date.now(), catalogStamp };
            modelCache.set(machineId, entry);
            persistCacheEntry(machineId, entry);
            return models;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/**
 * Returns the machine's OMP models. Serves the persisted list whenever it is
 * fresh or the catalog file is unchanged since it was fetched; the CLI only
 * runs after the user refreshed the catalog (stat stamp changed) or when no
 * list exists yet.
 */
export async function refreshOmpModels(machineId: string, cwd: string): Promise<OmpModelOption[]> {
    const cached = hydrateCacheEntry(machineId);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
        return cached.models;
    }

    const statResult = await machineBash(machineId, CATALOG_STAT_COMMAND, '/');
    const catalogStamp = statResult.success ? statResult.stdout.trim() : null;
    if (cached && catalogStamp !== null && catalogStamp === cached.catalogStamp) {
        const entry: OmpModelCacheEntry = { ...cached, fetchedAt: Date.now() };
        modelCache.set(machineId, entry);
        persistCacheEntry(machineId, entry);
        return cached.models;
    }

    try {
        return await fetchOmpModelsWithRetry(machineId, cwd, catalogStamp);
    } catch (error) {
        if (cached) {
            return cached.models;
        }
        console.warn(`OMP model list unavailable for machine ${machineId}:`, error instanceof Error ? error.message : error);
        throw error;
    }
}
