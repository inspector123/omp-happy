import { machineBash } from '@/sync/ops';

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

// `omp models --json` regularly takes 5+ seconds (the CLI retries provider
// checks), and the phone's socket to the server reconnects every few tens of
// seconds. A single RPC whose ack lands in a reconnect window is lost and the
// socket.io ack promise then never settles — so the fetch needs a timeout,
// retries, and a cache the picker can show while a refresh is in flight.
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const MODEL_FETCH_MAX_ATTEMPTS = 2;
const MODEL_CACHE_TTL_MS = 60_000;

const modelCache = new Map<string, { models: OmpModelOption[]; fetchedAt: number }>();

export function getCachedOmpModels(machineId: string): OmpModelOption[] | null {
    return modelCache.get(machineId)?.models ?? null;
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

async function fetchOmpModelsWithRetry(machineId: string, cwd: string): Promise<OmpModelOption[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MODEL_FETCH_MAX_ATTEMPTS; attempt++) {
        try {
            const models = await withTimeout(listOmpModels(machineId, cwd), MODEL_FETCH_TIMEOUT_MS, 'OMP model list');
            modelCache.set(machineId, { models, fetchedAt: Date.now() });
            return models;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/**
 * Returns the machine's OMP models, serving a cached list when one is fresh
 * (or when the refresh fails but an older list exists) so the picker does not
 * fall back to "default model" while the catalog is slow or the socket is
 * bouncing.
 */
export async function refreshOmpModels(machineId: string, cwd: string): Promise<OmpModelOption[]> {
    const cached = modelCache.get(machineId);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
        return cached.models;
    }
    try {
        return await fetchOmpModelsWithRetry(machineId, cwd);
    } catch (error) {
        if (cached) {
            return cached.models;
        }
        console.warn(`OMP model list unavailable for machine ${machineId}:`, error instanceof Error ? error.message : error);
        throw error;
    }
}
