import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);

/**
 * Usage snapshot for the companion app, from native OMP.
 *
 * Two independent sources:
 *   1. `omp usage --json` — provider quota windows, i.e. what `/usage` shows in
 *      the terminal: per-account rate limits, reset countdowns, banked resets.
 *   2. `~/.omp/stats.db` — the session index native OMP keeps in sync while it
 *      runs; token and cost rollups over the same columns the stats dashboard
 *      aggregates.
 *
 * The machine RPC that serves this must answer well inside the server's 30s RPC
 * timeout, so every slow path (provider fetch, session resync) is bounded and
 * falls back to the last good snapshot instead of blocking the caller.
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
    /** Local-midnight or N-day cutoff the window was measured from. */
    since: number;
    /** Newest message timestamp in the stats database. */
    newestTimestamp: number;
    totals: OmpTokenTotals;
    byModel: OmpTokenModelRow[];
    daily: OmpTokenDayPoint[];
}

export interface OmpUsageSnapshot {
    generatedAt: number;
    range: OmpUsageRange;
    ompBinary: string;
    /** Provider quota reports, or null when no provider fetch has succeeded. */
    limits: OmpUsageLimits | null;
    /** Token/cost rollup, or null when the stats database was unavailable. */
    tokens: OmpTokenUsage | null;
    /** Non-fatal problems, one human-readable line each. */
    errors: string[];
    /** True while a provider fetch is still running in the background. */
    refreshing: boolean;
    /** True while a session resync is running in the background. */
    syncing: boolean;
    /** Epoch ms of the last successful provider fetch, when one has run. */
    limitsFetchedAt?: number;
}

export interface CollectOmpUsageOptions {
    range?: OmpUsageRange;
    /** Ask native OMP to re-parse session files before reading the rollup. */
    resync?: boolean;
    now?: number;
    env?: NodeJS.ProcessEnv;
    home?: string;
    /** Test seam: replaces spawning the real omp binary. */
    runOmpJson?: (args: string[], timeoutMs: number) => Promise<unknown>;
    /** Test seam: replaces the read-only stats-database query. */
    readTokens?: (dbPath: string, range: OmpUsageRange, now: number) => Promise<OmpTokenUsage>;
}

const PROVIDER_FETCH_TIMEOUT_MS = 25_000;
const RESYNC_TIMEOUT_MS = 15 * 60_000;
/** How long a snapshot stays authoritative before a refresh is attempted. */
const SNAPSHOT_TTL_MS = 30_000;
/** Bound on how long a caller waits for an in-flight provider fetch. */
const REFRESH_WAIT_MS = 20_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MODEL_ROW_LIMIT = 20;

const RANGE_DAYS: Record<OmpUsageRange, number> = {
    today: 1,
    '7d': 7,
    '30d': 30,
};

const optionalNumber = z.number().finite().optional();
const optionalString = z.string().min(1).optional();

/** `omp usage --json` payload, narrowed to the fields the app renders. */
const usageReportSchema = z.object({
    provider: z.string(),
    fetchedAt: z.number().finite().default(0),
    notes: z.array(z.string()).optional(),
    metadata: z.object({
        email: optionalString,
        accountId: optionalString,
        projectId: optionalString,
        planType: optionalString,
    }).optional(),
    resetCredits: z.object({
        availableCount: z.number().finite().default(0),
        redeemableCount: optionalNumber,
        eligible: z.boolean().optional(),
        reason: optionalString,
        cooldownUntil: optionalString,
        credits: z.array(z.object({ expiresAt: optionalString })).optional(),
    }).optional(),
    limits: z.array(z.object({
        id: optionalString,
        label: z.string(),
        status: optionalString,
        notes: z.array(z.string()).optional(),
        amount: z.object({
            used: optionalNumber,
            limit: optionalNumber,
            remaining: optionalNumber,
            usedFraction: optionalNumber,
            remainingFraction: optionalNumber,
            unit: z.string().default('unknown'),
        }).default({ unit: 'unknown' }),
        scope: z.object({
            windowId: optionalString,
            tier: optionalString,
            shared: z.boolean().optional(),
            sharedGroup: optionalString,
        }).default({}),
        window: z.object({
            id: optionalString,
            label: optionalString,
            durationMs: optionalNumber,
            resetsAt: optionalNumber,
            resetLabel: optionalString,
        }).optional(),
    })).default([]),
});

const usagePayloadSchema = z.object({
    reports: z.array(usageReportSchema).default([]),
    capacity: z.record(z.string(), z.array(z.object({
        window: z.string(),
        durationMs: z.number().finite().default(0),
        meter: optionalString,
        accounts: z.number().finite().default(0),
        usedAccounts: z.number().finite().default(0),
        remainingAccounts: z.number().finite().default(0),
    }))).default({}),
    accountsWithoutUsage: z.array(z.unknown()).default([]),
    disabledCredentials: z.array(z.object({
        provider: z.string(),
        type: optionalString,
        cause: z.string().default('credential disabled'),
        accountId: optionalString,
        disabledAtMs: optionalNumber,
    })).default([]),
});

type UsageReportParsed = z.infer<typeof usageReportSchema>;

/**
 * Stats database rows. Shape is guaranteed by the queries below, so they are
 * asserted rather than re-validated per column.
 */
interface TotalsRow {
    requests: number | null;
    failed_requests: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    cost: number | null;
    premium_requests: number | null;
    avg_tokens_per_second: number | null;
}

interface ModelRow extends TotalsRow {
    model: string | null;
    provider: string | null;
}

interface DayRow {
    bucket: number;
    requests: number | null;
    tokens: number | null;
    cost: number | null;
}

/**
 * `omp` resolves the way the session wrapper resolves it: explicit override,
 * then the two well-known install locations, then PATH.
 */
export function resolveOmpBinary(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const override = env.OMP_HAPPY_REAL_BIN;
    if (typeof override === 'string' && override.length > 0) return override;
    const bunBinary = join(home, '.bun', 'bin', 'omp');
    if (existsSync(bunBinary)) return bunBinary;
    const localBinary = join(home, '.local', 'bin', 'omp');
    if (existsSync(localBinary)) return localBinary;
    return 'omp';
}

function augmentedPathEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
    const bunBin = join(home, '.bun', 'bin');
    const localBin = join(home, '.local', 'bin');
    const parts = (env.PATH ?? '').split(':').filter(Boolean);
    if (!parts.includes(localBin)) parts.unshift(localBin);
    if (!parts.includes(bunBin)) parts.unshift(bunBin);
    return { ...env, PATH: parts.join(':') };
}

/**
 * OMP prints progress lines around the JSON payload on some paths
 * (`omp stats` prints "Synced …"), so take the outermost JSON object.
 */
export function parseJsonOutput(stdout: string): unknown {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('OMP did not return JSON output');
    }
    return JSON.parse(stdout.slice(start, end + 1));
}

export async function defaultRunOmpJson(
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
    binary: string = resolveOmpBinary(env, home),
): Promise<unknown> {
    const { stdout } = await execFileAsync(binary, args, {
        encoding: 'utf8',
        env: augmentedPathEnv(env, home),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
    });
    return parseJsonOutput(stdout);
}

/**
 * Stats database location. Native OMP keeps it in its config root
 * (`~/.omp/stats.db`, `PI_CONFIG_DIR` override, `PI_PROFILE` sub-profile, or
 * `$XDG_DATA_HOME/omp` once migrated); `OMP_STATS_DB` pins it explicitly.
 */
export function resolveStatsDbPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
    const candidates: string[] = [];
    const pinned = env.OMP_STATS_DB;
    if (typeof pinned === 'string' && pinned.length > 0) candidates.push(pinned);

    const configDir = typeof env.PI_CONFIG_DIR === 'string' && env.PI_CONFIG_DIR.length > 0 ? env.PI_CONFIG_DIR : '.omp';
    const profile = env.PI_PROFILE;
    const root = typeof profile === 'string' && profile.length > 0
        ? join(home, configDir, 'profiles', profile)
        : join(home, configDir);
    candidates.push(join(root, 'stats.db'));

    const xdgData = env.XDG_DATA_HOME;
    if (typeof xdgData === 'string' && xdgData.length > 0) candidates.push(join(xdgData, 'omp', 'stats.db'));

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function rangeStart(range: OmpUsageRange, now: number): number {
    if (range === 'today') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return start.getTime();
    }
    return now - RANGE_DAYS[range] * 86_400_000;
}

function toTotals(row: TotalsRow | undefined): OmpTokenTotals {
    const inputTokens = row?.input_tokens ?? 0;
    const outputTokens = row?.output_tokens ?? 0;
    const cacheReadTokens = row?.cache_read_tokens ?? 0;
    const cacheWriteTokens = row?.cache_write_tokens ?? 0;
    return {
        requests: row?.requests ?? 0,
        failedRequests: row?.failed_requests ?? 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        cost: row?.cost ?? 0,
        premiumRequests: row?.premium_requests ?? 0,
        avgTokensPerSecond: row?.avg_tokens_per_second ?? null,
    };
}

const REQUIRED_MESSAGE_COLUMNS = [
    'timestamp',
    'model',
    'provider',
    'stop_reason',
    'duration',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'cost_total',
    'premium_requests',
] as const;

/**
 * Read-only token/cost rollup from the native stats index: same columns and
 * semantics the OMP dashboard aggregates (`cost_total`, cache reads counted in
 * total tokens, failures flagged by `stop_reason`).
 */
export async function readTokenUsage(
    dbPath: string,
    range: OmpUsageRange,
    now: number,
): Promise<OmpTokenUsage> {
    // Runtime-availability probe: node:sqlite is absent on Node < 22.5, so a
    // static import would take the whole CLI down on those runtimes.
    let DatabaseCtor: typeof DatabaseSync | undefined;
    try {
        const sqlite = await import('node:sqlite');
        DatabaseCtor = sqlite.DatabaseSync;
    } catch {
        DatabaseCtor = undefined;
    }
    if (!DatabaseCtor) {
        throw new Error('this runtime cannot open the OMP stats database (node:sqlite unavailable)');
    }
    const db = new DatabaseCtor(dbPath, { readOnly: true });
    try {
        db.exec('PRAGMA busy_timeout = 2000');
        const columns = new Set(
            (db.prepare('SELECT name FROM pragma_table_info(?)').all('messages') as { name: string }[])
                .map((row) => row.name),
        );
        const missing = REQUIRED_MESSAGE_COLUMNS.filter((column) => !columns.has(column));
        if (missing.length > 0) {
            throw new Error(`OMP stats database is missing columns: ${missing.join(', ')}`);
        }

        const since = rangeStart(range, now);
        // Local-day buckets so the chart agrees with the "Today" label.
        const tzOffsetMs = new Date(now).getTimezoneOffset() * -60_000;

        // node:sqlite hands back untyped rows; these queries own the column names.
        const totalsRow = db.prepare(`
            SELECT
                COUNT(*) AS requests,
                SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed_requests,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cost_total) AS cost,
                SUM(premium_requests) AS premium_requests,
                AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) AS avg_tokens_per_second
            FROM messages
            WHERE timestamp >= ?
        `).get(since) as unknown as TotalsRow | undefined;

        const modelRows = db.prepare(`
            SELECT
                model,
                provider,
                COUNT(*) AS requests,
                SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed_requests,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cost_total) AS cost,
                SUM(premium_requests) AS premium_requests,
                AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) AS avg_tokens_per_second
            FROM messages
            WHERE timestamp >= ?
            GROUP BY model, provider
            ORDER BY cost DESC, requests DESC
            LIMIT ${MODEL_ROW_LIMIT}
        `).all(since) as unknown as ModelRow[];

        const dayRows = db.prepare(`
            SELECT
                CAST((timestamp + ?) / 86400000 AS INTEGER) AS bucket,
                COUNT(*) AS requests,
                SUM(input_tokens + output_tokens) AS tokens,
                SUM(cost_total) AS cost
            FROM messages
            WHERE timestamp >= ?
            GROUP BY bucket
            ORDER BY bucket ASC
        `).all(tzOffsetMs, since) as unknown as DayRow[];

        const newest = db.prepare('SELECT MAX(timestamp) AS newest FROM messages')
            .get() as { newest: number | null } | undefined;

        return {
            range,
            since,
            newestTimestamp: newest?.newest ?? 0,
            totals: toTotals(totalsRow),
            byModel: modelRows.map((row) => ({
                model: row.model ?? 'unknown',
                provider: row.provider ?? 'unknown',
                ...toTotals(row),
            })),
            daily: dayRows.map((row) => ({
                timestamp: row.bucket * 86_400_000 - tzOffsetMs,
                requests: row.requests ?? 0,
                tokens: row.tokens ?? 0,
                cost: row.cost ?? 0,
            })),
        };
    } finally {
        db.close();
    }
}

function describeAccount(report: UsageReportParsed, index: number): OmpUsageAccount {
    const metadata = report.metadata ?? {};
    const label = metadata.email ?? metadata.accountId ?? metadata.projectId ?? `account ${index + 1}`;
    return { label, ...metadata };
}

/** Trim `omp usage --json` to display fields; raw provider quota blobs stay on the machine. */
export function normalizeUsageReports(payload: unknown): OmpUsageLimits {
    const parsed = usagePayloadSchema.parse(payload);
    return {
        reports: parsed.reports.map((report, index) => ({
            provider: report.provider,
            fetchedAt: report.fetchedAt,
            account: describeAccount(report, index),
            notes: report.notes,
            resetCredits: report.resetCredits
                ? {
                    availableCount: report.resetCredits.availableCount,
                    redeemableCount: report.resetCredits.redeemableCount,
                    eligible: report.resetCredits.eligible,
                    reason: report.resetCredits.reason,
                    cooldownUntil: report.resetCredits.cooldownUntil,
                    soonestExpiry: [...(report.resetCredits.credits ?? [])]
                        .map((credit) => credit.expiresAt)
                        .filter((expiry): expiry is string => expiry !== undefined)
                        .sort()[0],
                }
                : undefined,
            limits: report.limits.map((limit) => ({
                id: limit.id ?? `${report.provider}:${limit.label}`,
                label: limit.label,
                windowId: limit.scope.windowId ?? limit.window?.id,
                windowLabel: limit.window?.label,
                durationMs: limit.window?.durationMs,
                resetsAt: limit.window?.resetsAt,
                resetLabel: limit.window?.resetLabel,
                used: limit.amount.used,
                limit: limit.amount.limit,
                remaining: limit.amount.remaining,
                usedFraction: limit.amount.usedFraction,
                remainingFraction: limit.amount.remainingFraction,
                unit: limit.amount.unit,
                status: limit.status,
                notes: limit.notes,
                shared: limit.scope.shared,
                sharedGroup: limit.scope.sharedGroup,
                tier: limit.scope.tier,
            })),
        })),
        capacity: parsed.capacity,
        accountsWithoutUsage: parsed.accountsWithoutUsage.length,
        disabledCredentials: parsed.disabledCredentials,
    };
}

interface SnapshotCacheEntry {
    snapshot: OmpUsageSnapshot;
    at: number;
    limitsFetchedAt?: number;
}

interface ProviderFetchResult {
    limits: OmpUsageLimits | null;
    error: string | null;
    at: number;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();
let inFlightProviderFetch: Promise<ProviderFetchResult> | null = null;
let resyncRunning = false;
let resyncSettled: Promise<void> = Promise.resolve();

function startProviderFetch(
    runOmpJson: (args: string[], timeoutMs: number) => Promise<unknown>,
): Promise<ProviderFetchResult> {
    if (inFlightProviderFetch) return inFlightProviderFetch;
    const promise = (async (): Promise<ProviderFetchResult> => {
        try {
            const payload = await runOmpJson(['usage', '--json'], PROVIDER_FETCH_TIMEOUT_MS);
            return { limits: normalizeUsageReports(payload), error: null, at: Date.now() };
        } catch (error) {
            return { limits: null, error: error instanceof Error ? error.message : String(error), at: 0 };
        } finally {
            inFlightProviderFetch = null;
        }
    })();
    inFlightProviderFetch = promise;
    return promise;
}

/** Fire-and-forget: `omp stats` re-parses session files into the stats index. */
function startResync(
    runOmpJson: (args: string[], timeoutMs: number) => Promise<unknown>,
    onError: (message: string) => void,
): boolean {
    if (resyncRunning) return false;
    resyncRunning = true;
    resyncSettled = runOmpJson(['stats', '--json'], RESYNC_TIMEOUT_MS)
        .then(() => undefined, (error) => { onError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { resyncRunning = false; });
    return true;
}

/**
 * Build the usage snapshot for one machine. Never throws: each source degrades
 * independently and reports its problem in `errors`.
 */
export async function collectOmpUsage(options: CollectOmpUsageOptions = {}): Promise<OmpUsageSnapshot> {
    const now = options.now ?? Date.now();
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const range: OmpUsageRange = options.range ?? 'today';
    const runOmpJson = options.runOmpJson
        ?? ((args: string[], timeoutMs: number) => defaultRunOmpJson(args, timeoutMs, env, home));
    const readTokens = options.readTokens ?? readTokenUsage;
    const errors: string[] = [];

    const cacheKey = `${home}|${range}`;
    const cached = snapshotCache.get(cacheKey);
    const cacheAge = cached ? now - cached.at : Number.POSITIVE_INFINITY;
    const resyncRequested = options.resync === true;

    if (resyncRequested && startResync(runOmpJson, (message) => { errors.push(`Session resync failed: ${message}`); })) {
        // The rollup is about to change: drop the cached snapshot so the next
        // read re-queries the freshly synced database.
        snapshotCache.delete(cacheKey);
    }

    let limits = cached?.snapshot.limits ?? null;
    let limitsFetchedAt = cached?.limitsFetchedAt;
    let refreshing = false;
    if (!cached || cacheAge > SNAPSHOT_TTL_MS) {
        const fetch = startProviderFetch(runOmpJson);
        const settled = await Promise.race([
            fetch.then((result) => ({ done: true as const, result })),
            new Promise<{ done: false }>((resolve) => {
                setTimeout(() => resolve({ done: false }), REFRESH_WAIT_MS).unref?.();
            }),
        ]);
        if (settled.done) {
            if (settled.result.limits) {
                limits = settled.result.limits;
                limitsFetchedAt = settled.result.at;
            } else if (settled.result.error) {
                errors.push(`Provider usage fetch failed: ${settled.result.error}`);
            }
        } else {
            refreshing = true;
        }
    }

    let tokens = cached?.snapshot.tokens ?? null;
    if (!cached || cacheAge > SNAPSHOT_TTL_MS || resyncRequested) {
        const dbPath = resolveStatsDbPath(env, home);
        if (!dbPath) {
            if (!tokens) errors.push('OMP stats database not found; token totals unavailable');
        } else {
            try {
                tokens = await readTokens(dbPath, range, now);
            } catch (error) {
                errors.push(`Token totals unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    const snapshot: OmpUsageSnapshot = {
        generatedAt: now,
        range,
        ompBinary: resolveOmpBinary(env, home),
        limits,
        tokens,
        errors,
        refreshing,
        syncing: resyncRunning,
        limitsFetchedAt,
    };

    if (limits || tokens) {
        snapshotCache.set(cacheKey, { snapshot, at: now, limitsFetchedAt });
    }
    return snapshot;
}

/** Test seam: drop cached snapshots and in-flight state between cases. */
export function resetOmpUsageCacheForTests(): void {
    snapshotCache.clear();
    inFlightProviderFetch = null;
    resyncRunning = false;
    resyncSettled = Promise.resolve();
}

/** Test seam: resolves once the running session resync has settled. */
export function waitForResyncForTests(): Promise<void> {
    return resyncSettled;
}
