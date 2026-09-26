import { apiSocket } from './apiSocket';

/**
 * Client for the `omp-usage` machine RPC served by happy-cli on the user's
 * computer. The CLI is the source of truth for the payload shape: it reads
 * native OMP's provider quota reports (`omp usage --json`) and the token/cost
 * rollup from OMP's stats database. Keep these types in sync with
 * packages/happy-cli/src/omp/ompUsage.ts.
 */

export type OmpUsageRange = 'today' | '7d' | '30d';

export interface OmpUsageLimit {
    id: string;
    label: string;
    windowId?: string;
    windowLabel?: string;
    durationMs?: number;
    resetsAt?: number;
    resetLabel?: string;
    used?: number;
    limit?: number;
    remaining?: number;
    usedFraction?: number;
    remainingFraction?: number;
    unit: string;
    status?: string;
    notes?: string[];
    shared?: boolean;
    sharedGroup?: string;
    tier?: string;
}

export interface OmpUsageAccount {
    label: string;
    email?: string;
    accountId?: string;
    projectId?: string;
    planType?: string;
}

export interface OmpUsageResetCredits {
    availableCount: number;
    redeemableCount?: number;
    eligible?: boolean;
    reason?: string;
    cooldownUntil?: string;
    soonestExpiry?: string;
}

export interface OmpUsageReport {
    provider: string;
    fetchedAt: number;
    account: OmpUsageAccount;
    notes?: string[];
    resetCredits?: OmpUsageResetCredits;
    limits: OmpUsageLimit[];
}

export interface OmpUsageCapacityWindow {
    window: string;
    durationMs: number;
    meter?: string;
    accounts: number;
    usedAccounts: number;
    remainingAccounts: number;
}

export interface OmpUsageDisabledCredential {
    provider: string;
    type?: string;
    cause: string;
    accountId?: string;
    disabledAtMs?: number;
}

export interface OmpUsageLimits {
    reports: OmpUsageReport[];
    capacity: Record<string, OmpUsageCapacityWindow[]>;
    accountsWithoutUsage: number;
    disabledCredentials: OmpUsageDisabledCredential[];
}

export interface OmpTokenTotals {
    requests: number;
    failedRequests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    cost: number;
    premiumRequests: number;
    avgTokensPerSecond: number | null;
}

export interface OmpTokenModelRow extends OmpTokenTotals {
    model: string;
    provider: string;
}

export interface OmpTokenDayPoint {
    /** Local calendar-day start, unix ms. */
    timestamp: number;
    requests: number;
    tokens: number;
    cost: number;
}

export interface OmpTokenUsage {
    range: OmpUsageRange;
    since: number;
    newestTimestamp: number;
    totals: OmpTokenTotals;
    byModel: OmpTokenModelRow[];
    daily: OmpTokenDayPoint[];
}

export interface OmpUsageSnapshot {
    generatedAt: number;
    range: OmpUsageRange;
    ompBinary: string;
    limits: OmpUsageLimits | null;
    tokens: OmpTokenUsage | null;
    errors: string[];
    refreshing: boolean;
    syncing: boolean;
    limitsFetchedAt?: number;
}

export async function fetchMachineOmpUsage(
    machineId: string,
    options: { range: OmpUsageRange; resync?: boolean },
): Promise<OmpUsageSnapshot> {
    return await apiSocket.machineRPC<OmpUsageSnapshot, { range: OmpUsageRange; resync?: boolean }>(
        machineId,
        'omp-usage',
        { range: options.range, resync: options.resync ?? false },
    );
}
