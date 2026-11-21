import { homedir } from 'node:os';
import { z } from 'zod';
import { defaultRunOmpJson } from './ompUsage';

/** One model offered by the OMP catalog on this machine. */
export interface OmpModelOption {
    key: string;
    name: string;
    description?: string | null;
}

/** Snapshot served by the `omp-models` machine RPC. */
export interface OmpModelsSnapshot {
    models: OmpModelOption[];
    defaultModel: string | null;
    fetchedAt: number | null;
    refreshing: boolean;
    error: string | null;
}

export interface CollectOmpModelsOptions {
    /** Test seam: replaces spawning the real omp binary. */
    runOmpJson?: (args: string[], timeoutMs: number) => Promise<unknown>;
    now?: number;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Test seam: how long to wait for the catalog before answering "refreshing". */
    refreshWaitMs?: number;
    /** Ignore the cached snapshot and start a refresh. */
    force?: boolean;
}

// `omp models --json` re-checks every provider before printing and takes about
// 60 s on this machine, far past the server's 30 s machine-RPC call timeout.
// The daemon therefore keeps the last catalog in memory, answers from it, and
// refreshes in the background; the app polls while `refreshing` is true.
const MODEL_FETCH_TIMEOUT_MS = 150_000;
const REFRESH_WAIT_MS = 10_000;
const SNAPSHOT_TTL_MS = 5 * 60_000;

const catalogSchema = z.object({
    models: z.array(z.unknown()),
});

const modelEntrySchema = z.object({
    selector: z.string(),
    name: z.string().optional(),
});

const defaultsSchema = z.object({
    value: z.object({
        default: z.string().optional(),
    }),
});

/**
 * Map the CLI catalog to picker options. Selectors are unique keys; the
 * display name becomes a searchable description when it differs.
 */
export function normalizeOmpModelCatalog(payload: unknown): OmpModelOption[] {
    const parsed = catalogSchema.safeParse(payload);
    if (!parsed.success) {
        throw new Error('OMP model catalog response is invalid');
    }

    const seen = new Set<string>();
    const models: OmpModelOption[] = [];
    for (const candidate of parsed.data.models) {
        const entry = modelEntrySchema.safeParse(candidate);
        if (!entry.success) {
            continue;
        }
        const selector = entry.data.selector.trim();
        if (!selector || seen.has(selector)) {
            continue;
        }
        seen.add(selector);

        const displayName = entry.data.name?.trim() ?? '';
        models.push({
            key: selector,
            name: selector,
            description: displayName && displayName !== selector ? displayName : null,
        });
    }
    return models;
}

export function normalizeOmpDefaultModel(payload: unknown): string | null {
    const parsed = defaultsSchema.safeParse(payload);
    if (!parsed.success) {
        return null;
    }
    const configuredDefault = parsed.data.value.default?.trim();
    return configuredDefault ? configuredDefault : null;
}

interface ModelSnapshotData {
    models: OmpModelOption[];
    defaultModel: string | null;
    at: number;
}

interface ModelFetchResult {
    data: ModelSnapshotData | null;
    error: string | null;
}

let cachedSnapshot: ModelSnapshotData | null = null;
let inFlightFetch: Promise<ModelFetchResult> | null = null;

function startModelFetch(
    runOmpJson: (args: string[], timeoutMs: number) => Promise<unknown>,
): Promise<ModelFetchResult> {
    if (inFlightFetch) return inFlightFetch;
    const promise = (async (): Promise<ModelFetchResult> => {
        try {
            const [catalog, roles] = await Promise.all([
                runOmpJson(['models', '--json'], MODEL_FETCH_TIMEOUT_MS),
                runOmpJson(['config', 'get', 'modelRoles', '--json'], MODEL_FETCH_TIMEOUT_MS)
                    .catch(() => null),
            ]);
            return {
                data: {
                    models: normalizeOmpModelCatalog(catalog),
                    defaultModel: normalizeOmpDefaultModel(roles),
                    at: Date.now(),
                },
                error: null,
            };
        } catch (error) {
            return { data: null, error: error instanceof Error ? error.message : String(error) };
        } finally {
            inFlightFetch = null;
        }
    })();
    inFlightFetch = promise;
    return promise;
}

/**
 * Build the model catalog snapshot for one machine. Never throws: a failed
 * refresh reports its error and keeps the last good snapshot.
 */
export async function collectOmpModels(options: CollectOmpModelsOptions = {}): Promise<OmpModelsSnapshot> {
    const now = options.now ?? Date.now();
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const waitMs = options.refreshWaitMs ?? REFRESH_WAIT_MS;
    const runOmpJson = options.runOmpJson
        ?? ((args: string[], timeoutMs: number) => defaultRunOmpJson(args, timeoutMs, env, home));

    const cacheAge = cachedSnapshot ? now - cachedSnapshot.at : Number.POSITIVE_INFINITY;
    let refreshing = false;
    let error: string | null = null;

    if (!cachedSnapshot || cacheAge > SNAPSHOT_TTL_MS || options.force === true) {
        const fetch = startModelFetch(runOmpJson);
        const deadline = Promise.withResolvers<{ done: false }>();
        const timer = setTimeout(() => deadline.resolve({ done: false }), waitMs);
        timer.unref?.();
        const settled = await Promise.race([
            fetch.then((result) => ({ done: true as const, result })),
            deadline.promise,
        ]);
        clearTimeout(timer);
        if (settled.done) {
            if (settled.result.data) {
                cachedSnapshot = settled.result.data;
            } else {
                error = settled.result.error;
            }
        } else {
            refreshing = true;
        }
    }

    return {
        models: cachedSnapshot?.models ?? [],
        defaultModel: cachedSnapshot?.defaultModel ?? null,
        fetchedAt: cachedSnapshot?.at ?? null,
        refreshing,
        error,
    };
}

/** Test seam: drop the cached snapshot and in-flight state between cases. */
export function resetOmpModelsCacheForTests(): void {
    cachedSnapshot = null;
    inFlightFetch = null;
}
