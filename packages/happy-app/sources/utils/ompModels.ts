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
