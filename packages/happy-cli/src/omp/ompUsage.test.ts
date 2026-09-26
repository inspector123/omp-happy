import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
    collectOmpUsage,
    normalizeUsageReports,
    parseJsonOutput,
    readTokenUsage,
    resetOmpUsageCacheForTests,
    waitForResyncForTests,
    resolveStatsDbPath,
    type OmpUsageSnapshot,
} from './ompUsage';

const DAY_MS = 86_400_000;

let workDir: string;

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'omp-usage-'));
});

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

function createStatsDb(name: string, rows: Array<{
    timestamp: number;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cost: number;
    duration: number;
    error?: boolean;
}>): string {
    const dbPath = join(workDir, name);
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            stop_reason TEXT NOT NULL,
            duration INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cost_total REAL NOT NULL,
            premium_requests REAL NOT NULL
        )
    `);
    const insert = db.prepare(`
        INSERT INTO messages (timestamp, model, provider, stop_reason, duration, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_total, premium_requests)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
        insert.run(
            row.timestamp,
            row.model,
            row.provider,
            row.error ? 'error' : 'end_turn',
            row.duration,
            row.inputTokens,
            row.outputTokens,
            row.cacheReadTokens,
            0,
            row.cost,
            0,
        );
    }
    db.close();
    return dbPath;
}

describe('parseJsonOutput', () => {
    it('drops the progress lines OMP prints around the payload', () => {
        expect(parseJsonOutput('Synced 261958 new entries from 2455 files\n{"overall":{"totalRequests":3}}\n'))
            .toEqual({ overall: { totalRequests: 3 } });
    });

    it('rejects output with no JSON object', () => {
        expect(() => parseJsonOutput('Usage is unavailable right now')).toThrow('OMP did not return JSON output');
    });
});

describe('normalizeUsageReports', () => {
    const payload = {
        generatedAt: 1,
        reports: [
            {
                provider: 'openai-codex',
                fetchedAt: 1000,
                metadata: {
                    planType: 'pro',
                    email: 'user@example.com',
                    accountId: 'acct-1',
                    rawQuotaResponse: { huge: 'blob' },
                },
                resetCredits: {
                    availableCount: 2,
                    credits: [{ expiresAt: '2026-10-05T00:00:00Z' }, { expiresAt: '2026-10-04T00:00:00Z' }],
                },
                limits: [
                    {
                        id: 'openai-codex:primary',
                        label: '7 days',
                        status: 'ok',
                        scope: { provider: 'openai-codex', windowId: '7d', shared: true },
                        window: { id: '7d', label: '7 days', durationMs: 604_800_000, resetsAt: 1_791_046_694_000 },
                        amount: { used: 11, limit: 100, remaining: 89, usedFraction: 0.11, unit: 'percent' },
                    },
                ],
            },
            {
                provider: 'zai',
                fetchedAt: 2000,
                metadata: { endpoint: 'https://api.z.ai', planType: 'pro' },
                limits: [
                    {
                        label: 'ZAI Weekly Credit Quota',
                        scope: { provider: 'zai', windowId: '1w' },
                        window: { id: '1w', label: 'Weekly', durationMs: 604_800_000 },
                        amount: { used: 28273, limit: 60000, unit: 'credits' },
                    },
                ],
            },
        ],
        capacity: {
            zai: [{ window: '7d', durationMs: 604_800_000, accounts: 1, usedAccounts: 0.47, remainingAccounts: 0.53 }],
        },
        accountsWithoutUsage: [{ provider: 'kimi-code' }],
        disabledCredentials: [
            { id: 3, provider: 'kimi-code', type: 'oauth', cause: 'token refresh failed', disabledAtMs: 1_789_498_274_000 },
        ],
    };

    const normalized = normalizeUsageReports(payload);

    it('flattens window, scope and amount onto each limit', () => {
        expect(normalized.reports[0]!.limits[0]).toEqual({
            id: 'openai-codex:primary',
            label: '7 days',
            windowId: '7d',
            windowLabel: '7 days',
            durationMs: 604_800_000,
            resetsAt: 1_791_046_694_000,
            resetLabel: undefined,
            used: 11,
            limit: 100,
            remaining: 89,
            usedFraction: 0.11,
            remainingFraction: undefined,
            unit: 'percent',
            status: 'ok',
            notes: undefined,
            shared: true,
            sharedGroup: undefined,
            tier: undefined,
        });
    });

    it('labels accounts by email, then account id, then position', () => {
        expect(normalized.reports[0]!.account).toEqual({
            label: 'user@example.com',
            email: 'user@example.com',
            accountId: 'acct-1',
            projectId: undefined,
            planType: 'pro',
        });
        expect(normalized.reports[1]!.account.label).toBe('account 2');
    });

    it('synthesizes a limit id when the provider omits one', () => {
        expect(normalized.reports[1]!.limits[0]!.id).toBe('zai:ZAI Weekly Credit Quota');
    });

    it('keeps the earliest banked-reset expiry', () => {
        expect(normalized.reports[0]!.resetCredits).toEqual({
            availableCount: 2,
            redeemableCount: undefined,
            eligible: undefined,
            reason: undefined,
            cooldownUntil: undefined,
            soonestExpiry: '2026-10-04T00:00:00Z',
        });
    });

    it('does not forward raw provider quota blobs', () => {
        expect(JSON.stringify(normalized)).not.toContain('rawQuotaResponse');
        expect(JSON.stringify(normalized)).not.toContain('huge');
    });

    it('counts accounts without usage and keeps disabled credentials', () => {
        expect(normalized.accountsWithoutUsage).toBe(1);
        expect(normalized.disabledCredentials).toEqual([{
            provider: 'kimi-code',
            type: 'oauth',
            cause: 'token refresh failed',
            accountId: undefined,
            disabledAtMs: 1_789_498_274_000,
        }]);
        expect(normalized.capacity.zai?.[0]?.usedAccounts).toBe(0.47);
    });

    it('tolerates a payload with no limits or amounts', () => {
        const sparse = normalizeUsageReports({ reports: [{ provider: 'anthropic', fetchedAt: 5 }] });
        expect(sparse.reports[0]).toMatchObject({ provider: 'anthropic', limits: [], resetCredits: undefined });
    });
});

describe('resolveStatsDbPath', () => {
    it('prefers an explicitly pinned database', () => {
        const pinned = join(workDir, 'pinned.db');
        writeFileSync(pinned, '');
        expect(resolveStatsDbPath({ OMP_STATS_DB: pinned }, workDir)).toBe(pinned);
    });

    it('resolves the config root, then the profile sub-root, then XDG', () => {
        const home = join(workDir, 'home');
        mkdirSync(join(home, '.omp'), { recursive: true });
        writeFileSync(join(home, '.omp', 'stats.db'), '');
        expect(resolveStatsDbPath({}, home)).toBe(join(home, '.omp', 'stats.db'));
        expect(resolveStatsDbPath({ PI_CONFIG_DIR: 'omp-config' }, home)).toBeNull();

        // A named profile must not borrow the base profile's database.
        expect(resolveStatsDbPath({ PI_PROFILE: 'work' }, home)).toBeNull();
        mkdirSync(join(home, '.omp', 'profiles', 'work'), { recursive: true });
        writeFileSync(join(home, '.omp', 'profiles', 'work', 'stats.db'), '');
        expect(resolveStatsDbPath({ PI_PROFILE: 'work' }, home))
            .toBe(join(home, '.omp', 'profiles', 'work', 'stats.db'));

        const xdg = join(workDir, 'xdg');
        mkdirSync(join(xdg, 'omp'), { recursive: true });
        writeFileSync(join(xdg, 'omp', 'stats.db'), '');
        expect(resolveStatsDbPath({ XDG_DATA_HOME: xdg }, join(workDir, 'empty-home')))
            .toBe(join(xdg, 'omp', 'stats.db'));
    });

    it('returns null when no candidate exists', () => {
        expect(resolveStatsDbPath({}, join(workDir, 'nope'))).toBeNull();
    });
});

describe('readTokenUsage', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);

    it('aggregates totals, per-model rows and local-day buckets inside the range', async () => {
        const dbPath = createStatsDb('tokens.db', [
            // Today: two requests on the same model plus one on another.
            { timestamp: now - 3_600_000, model: 'sol', provider: 'openai-codex', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cost: 1.5, duration: 2000 },
            { timestamp: now - 1_800_000, model: 'sol', provider: 'openai-codex', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cost: 0.5, duration: 1000, error: true },
            { timestamp: now - 900_000, model: 'flash', provider: 'zlocal', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cost: 0, duration: 500 },
            // Outside a 7d window.
            { timestamp: now - 9 * DAY_MS, model: 'sol', provider: 'openai-codex', inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 0, cost: 99, duration: 1000 },
        ]);

        const usage = await readTokenUsage(dbPath, '7d', now);

        expect(usage.totals).toEqual({
            requests: 3,
            failedRequests: 1,
            inputTokens: 1510,
            outputTokens: 305,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            totalTokens: 2315,
            cost: 2,
            premiumRequests: 0,
            avgTokensPerSecond: (200 / 2 + 100 / 1 + 5 / 0.5) / 3,
        });
        expect(usage.byModel[0]).toMatchObject({ model: 'sol', provider: 'openai-codex', requests: 2, cost: 2 });
        expect(usage.byModel[1]).toMatchObject({ model: 'flash', requests: 1, cost: 0 });
        expect(usage.daily).toHaveLength(1);
        expect(usage.daily[0]).toMatchObject({ requests: 3, tokens: 1815, cost: 2 });
        // Bucket start is local midnight for the day containing `now`.
        expect(new Date(usage.daily[0]!.timestamp).getHours()).toBe(0);
        expect(usage.newestTimestamp).toBe(now - 900_000);
    });

    it('splits daily buckets across local midnight', async () => {
        // One request yesterday and one today, both at local noon so the split
        // does not depend on the machine's UTC offset.
        const todayMidnight = new Date(now);
        todayMidnight.setHours(0, 0, 0, 0);
        const yesterdayMidnight = new Date(todayMidnight);
        yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);
        const yesterdayNoon = new Date(yesterdayMidnight);
        yesterdayNoon.setHours(12, 0, 0, 0);
        const todayNoon = new Date(todayMidnight);
        todayNoon.setHours(12, 0, 0, 0);

        const dbPath = createStatsDb('days.db', [
            { timestamp: yesterdayNoon.getTime(), model: 'sol', provider: 'p', inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cost: 1, duration: 100 },
            { timestamp: todayNoon.getTime(), model: 'sol', provider: 'p', inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cost: 2, duration: 100 },
        ]);

        const usage = await readTokenUsage(dbPath, '30d', now);

        expect(usage.daily.map((day) => day.tokens)).toEqual([20, 40]);
        expect(usage.daily.map((day) => day.timestamp)).toEqual([
            yesterdayMidnight.getTime(),
            todayMidnight.getTime(),
        ]);
    });

    it('reports a schema mismatch instead of returning zeros', async () => {
        const dbPath = join(workDir, 'broken.db');
        const db = new DatabaseSync(dbPath);
        db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, model TEXT)');
        db.close();

        await expect(readTokenUsage(dbPath, 'today', now)).rejects.toThrow(/missing columns: .*stop_reason/);
    });
});

describe('collectOmpUsage', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    let dbPath: string;
    let env: NodeJS.ProcessEnv;

    const usagePayload = {
        reports: [{
            provider: 'anthropic',
            fetchedAt: 123,
            metadata: { email: 'me@example.com', planType: 'max' },
            limits: [{
                label: '5 hours',
                scope: { windowId: '5h' },
                window: { id: '5h', label: '5 Hours', durationMs: 18_000_000, resetsAt: now + 3_600_000 },
                amount: { usedFraction: 0.42, unit: 'percent' },
            }],
        }],
    };

    beforeEach(() => {
        resetOmpUsageCacheForTests();
        dbPath = createStatsDb(`collect-${Math.random().toString(36).slice(2)}.db`, [
            { timestamp: now - 60_000, model: 'sol', provider: 'openai-codex', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cost: 0.25, duration: 1000 },
        ]);
        env = { OMP_STATS_DB: dbPath, HOME: workDir };
    });

    afterEach(() => {
        resetOmpUsageCacheForTests();
    });

    it('combines provider reports with the token rollup', async () => {
        const runOmpJson = vi.fn().mockResolvedValue(usagePayload);
        const readTokens = vi.fn().mockResolvedValue({
            range: 'today' as const,
            since: now - 1000,
            newestTimestamp: now,
            totals: { requests: 1, failedRequests: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, cost: 0.25, premiumRequests: 0, avgTokensPerSecond: 50 },
            byModel: [],
            daily: [],
        });

        const snapshot = await collectOmpUsage({ now, env, home: workDir, runOmpJson, readTokens });

        expect(runOmpJson).toHaveBeenCalledWith(['usage', '--json'], expect.any(Number));
        expect(readTokens).toHaveBeenCalledWith(dbPath, 'today', now);
        expect(snapshot.limits?.reports[0]).toMatchObject({
            provider: 'anthropic',
            account: { label: 'me@example.com' },
            limits: [{ usedFraction: 0.42, windowId: '5h' }],
        });
        expect(snapshot.tokens?.totals.requests).toBe(1);
        expect(snapshot.errors).toEqual([]);
        expect(snapshot.refreshing).toBe(false);
        expect(snapshot.limitsFetchedAt).toBeGreaterThan(0);
    });

    it('serves the cached snapshot without re-running the slow sources', async () => {
        const runOmpJson = vi.fn().mockResolvedValue(usagePayload);
        const readTokens = vi.fn().mockResolvedValue({
            range: 'today' as const,
            since: now,
            newestTimestamp: now,
            totals: { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, premiumRequests: 0, avgTokensPerSecond: null },
            byModel: [],
            daily: [],
        });

        await collectOmpUsage({ now, env, home: workDir, runOmpJson, readTokens });
        const second = await collectOmpUsage({ now: now + 10_000, env, home: workDir, runOmpJson, readTokens });

        expect(runOmpJson).toHaveBeenCalledTimes(1);
        expect(readTokens).toHaveBeenCalledTimes(1);
        expect(second.generatedAt).toBe(now + 10_000);
        expect(second.limits?.reports[0]?.provider).toBe('anthropic');
    });

    it('degrades to token totals when the provider fetch fails', async () => {
        const snapshot = await collectOmpUsage({
            now,
            env,
            home: workDir,
            runOmpJson: vi.fn().mockRejectedValue(new Error('boom')),
        });

        expect(snapshot.limits).toBeNull();
        expect(snapshot.errors).toEqual(['Provider usage fetch failed: boom']);
        expect(snapshot.tokens?.totals.requests).toBe(1);
    });

    it('degrades to provider reports when the stats database is missing', async () => {
        const snapshot = await collectOmpUsage({
            now,
            env: { OMP_STATS_DB: join(workDir, 'definitely-missing.db') },
            home: workDir,
            runOmpJson: vi.fn().mockResolvedValue(usagePayload),
        });

        expect(snapshot.limits?.reports[0]?.provider).toBe('anthropic');
        expect(snapshot.tokens).toBeNull();
        expect(snapshot.errors).toEqual(['OMP stats database not found; token totals unavailable']);
    });

    it('reports a real read error rather than a stale empty panel', async () => {
        const snapshot = await collectOmpUsage({
            now,
            env,
            home: workDir,
            runOmpJson: vi.fn().mockResolvedValue(usagePayload),
            readTokens: vi.fn().mockRejectedValue(new Error('database is locked')),
        });

        expect(snapshot.tokens).toBeNull();
        expect(snapshot.errors).toEqual(['Token totals unavailable: database is locked']);
    });

    it('kicks off a session resync and invalidates the cached rollup', async () => {
        const { promise: resyncGate, resolve: releaseResync } = Promise.withResolvers<void>();
        const runOmpJson = vi.fn((args: string[]) => (
            args[0] === 'stats' ? resyncGate.then(() => ({})) : Promise.resolve(usagePayload)
        ));

        await collectOmpUsage({ now, env, home: workDir, runOmpJson });

        const during = await collectOmpUsage({ now: now + 1_000, env, home: workDir, runOmpJson, resync: true });
        expect(runOmpJson).toHaveBeenLastCalledWith(['stats', '--json'], expect.any(Number));
        expect(during.syncing).toBe(true);

        releaseResync();
        await waitForResyncForTests();

        const after = await collectOmpUsage({ now: now + 2_000, env, home: workDir, runOmpJson });
        expect(after.syncing).toBe(false);
        expect(after.tokens?.newestTimestamp).toBe(now - 60_000);
    });

    it('keeps each range cached separately', async () => {
        const runOmpJson = vi.fn().mockResolvedValue(usagePayload);
        const readTokens = vi.fn().mockImplementation(
            async (_dbPath: string, range: string) => ({
                range,
                since: now,
                newestTimestamp: now,
                totals: { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, premiumRequests: 0, avgTokensPerSecond: null },
                byModel: [],
                daily: [],
            }),
        );

        await collectOmpUsage({ now, env, home: workDir, runOmpJson, readTokens });
        const week = await collectOmpUsage({ now, range: '7d', env, home: workDir, runOmpJson, readTokens });

        expect(week.range).toBe('7d');
        expect(readTokens).toHaveBeenLastCalledWith(dbPath, '7d', now);
        expect(runOmpJson).toHaveBeenCalledTimes(2);
    });

    it('surfaces both sources as unavailable without throwing', async () => {
        const snapshot: OmpUsageSnapshot = await collectOmpUsage({
            now,
            env: {},
            home: workDir,
            runOmpJson: vi.fn().mockRejectedValue(new Error('omp: not found')),
        });

        expect(snapshot.limits).toBeNull();
        expect(snapshot.tokens).toBeNull();
        expect(snapshot.errors).toHaveLength(2);
    });
});
