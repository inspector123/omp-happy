import { describe, expect, it } from 'vitest';
import type { OmpUsageLimit, OmpUsageReport } from '@/sync/apiOmpUsage';
import {
    collapseSharedLimits,
    formatAgo,
    formatCompactNumber,
    formatCountdown,
    formatCost,
    formatDayLabel,
    formatRemainingAmount,
    formatUsedAmount,
    groupReportsByProvider,
    limitTitle,
    providerDisplayName,
    resolveUsedFraction,
    usageSeverity,
} from './ompUsageFormat';

function limit(overrides: Partial<OmpUsageLimit>): OmpUsageLimit {
    return { id: 'id', label: 'Window', unit: 'percent', ...overrides };
}

describe('resolveUsedFraction', () => {
    it('prefers an explicit fraction over the raw amounts', () => {
        expect(resolveUsedFraction(limit({ usedFraction: 0.25, used: 90, limit: 100 }))).toBe(0.25);
    });

    it('falls back to used over limit, then percent, then inverted remaining', () => {
        expect(resolveUsedFraction(limit({ used: 30, limit: 120 }))).toBeCloseTo(0.25);
        expect(resolveUsedFraction(limit({ unit: 'percent', used: 42 }))).toBeCloseTo(0.42);
        expect(resolveUsedFraction(limit({ remainingFraction: 0.7887944 }))).toBeCloseTo(0.2112056);
    });

    it('returns undefined when the provider reported nothing usable', () => {
        expect(resolveUsedFraction(limit({}))).toBeUndefined();
        expect(resolveUsedFraction(limit({ unit: 'credits', used: 5, limit: 0 }))).toBeUndefined();
    });

    it('clamps an inverted-remaining report at zero used', () => {
        expect(resolveUsedFraction(limit({ remainingFraction: 1.4 }))).toBe(0);
    });

    it('keeps overage above one', () => {
        expect(resolveUsedFraction(limit({ used: 140, limit: 100 }))).toBe(1.4);
    });
});

describe('usageSeverity', () => {
    it.each([
        [0, 'ok'],
        [0.69, 'ok'],
        [0.7, 'warning'],
        [0.89, 'warning'],
        [0.9, 'critical'],
        [1.4, 'critical'],
    ])('maps %s to %s', (fraction, expected) => {
        expect(usageSeverity(fraction)).toBe(expected);
    });

    it('marks an unreported fraction as unknown', () => {
        expect(usageSeverity(undefined)).toBe('unknown');
    });
});

describe('numeric formatting', () => {
    it('compacts large token counts and keeps small ones exact', () => {
        expect(formatCompactNumber(0)).toBe('0');
        expect(formatCompactNumber(1_234)).toBe('1,234');
        expect(formatCompactNumber(9_999)).toBe('9,999');
        expect(formatCompactNumber(45_678)).toBe('45.7K');
        expect(formatCompactNumber(3_400_000)).toBe('3.4M');
        expect(formatCompactNumber(6_173_398_432)).toBe('6.17B');
    });

    it('formats cost with the precision the magnitude deserves', () => {
        expect(formatCost(0)).toBe('$0');
        expect(formatCost(0.0031)).toBe('$0.0031');
        expect(formatCost(0.4249)).toBe('$0.42');
        expect(formatCost(2015.836072415)).toBe('$2,015.84');
        expect(formatCost(12345.5)).toBe('$12,345.5');
    });

    it('formats a reset countdown down to the minute', () => {
        expect(formatCountdown(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
        expect(formatCountdown(3 * 86_400_000)).toBe('3d');
        expect(formatCountdown(6 * 3_600_000 + 12 * 60_000)).toBe('6h 12m');
        expect(formatCountdown(42 * 60_000)).toBe('42m');
        expect(formatCountdown(30_000)).toBe('<1m');
        expect(formatCountdown(-1)).toBe('<1m');
    });

    it('formats elapsed time for the freshness line', () => {
        expect(formatAgo(1_000)).toBe('just now');
        expect(formatAgo(42_000)).toBe('42s ago');
        expect(formatAgo(7 * 60_000)).toBe('7m ago');
        expect(formatAgo(3 * 3_600_000)).toBe('3h ago');
        expect(formatAgo(5 * 86_400_000)).toBe('5d ago');
    });
});

describe('quota amount text', () => {
    it('renders percent quotas as fractions', () => {
        const weekly = limit({ label: '7 days', usedFraction: 0.11 });
        expect(formatUsedAmount(weekly)).toBe('11%');
        expect(formatRemainingAmount(weekly)).toBe('89%');
    });

    it('renders credit quotas as absolute amounts with their unit', () => {
        const credits = limit({
            label: 'Weekly',
            unit: 'credits',
            used: 28_273,
            limit: 60_000,
            remaining: 31_726,
        });
        expect(formatUsedAmount(credits)).toBe('28,273 / 60,000 credits');
        expect(formatRemainingAmount(credits)).toBe('31,726 credits');
    });

    it('derives the remainder when only used and limit are reported', () => {
        const credits = limit({ unit: 'credits', used: 1_000, limit: 4_000 });
        expect(formatRemainingAmount(credits)).toBe('3,000 credits');
    });

    it('renders a unit-less quota as a percent fallback', () => {
        expect(formatUsedAmount(limit({ unit: 'unknown', usedFraction: 0.337 }))).toBe('33.7%');
        expect(formatRemainingAmount(limit({ unit: 'unknown', remainingFraction: 0.5 }))).toBe('50%');
    });

    it('returns nothing when no amount was reported', () => {
        expect(formatUsedAmount(limit({}))).toBeUndefined();
        expect(formatRemainingAmount(limit({}))).toBeUndefined();
    });
});

describe('limitTitle', () => {
    it('appends tier and window qualifiers', () => {
        expect(limitTitle(limit({ label: 'Claude', tier: 'fable', windowLabel: 'Weekly' })))
            .toBe('Claude (fable) · Weekly');
    });

    it('skips qualifiers the label already contains', () => {
        expect(limitTitle(limit({ label: 'Claude 7 Day (Fable)', tier: 'fable', windowLabel: '7 Day' })))
            .toBe('Claude 7 Day (Fable)');
        expect(limitTitle(limit({ label: 'Weekly', windowLabel: 'Weekly' }))).toBe('Weekly');
    });
});

describe('collapseSharedLimits', () => {
    it('keeps the most spent copy of one shared upstream quota', () => {
        const collapsed = collapseSharedLimits([
            limit({ id: 'a', label: 'Claude & GPT (shared)', shared: true, sharedGroup: '3p-weekly', usedFraction: 0 }),
            limit({ id: 'b', label: 'Claude & GPT (shared)', shared: true, sharedGroup: '3p-weekly', usedFraction: 0.5 }),
            limit({ id: 'c', label: 'Gemini', usedFraction: 0.21 }),
        ]);
        expect(collapsed.map((entry) => entry.id)).toEqual(['b', 'c']);
    });

    it('dedupes byte-identical rows that carry no shared group', () => {
        const collapsed = collapseSharedLimits([
            limit({ id: 'a', label: 'Weekly', windowId: '1w', usedFraction: 0.1 }),
            limit({ id: 'b', label: 'weekly', windowId: '1w', usedFraction: 0.4 }),
        ]);
        expect(collapsed.map((entry) => entry.id)).toEqual(['b']);
    });

    it('keeps distinct windows of the same label separate', () => {
        const collapsed = collapseSharedLimits([
            limit({ id: 'a', label: 'Quota', windowId: '5h' }),
            limit({ id: 'b', label: 'Quota', windowId: '1w' }),
        ]);
        expect(collapsed.map((entry) => entry.id)).toEqual(['a', 'b']);
    });
});

describe('groupReportsByProvider', () => {
    it('groups accounts under their provider in first-seen order', () => {
        const report = (provider: string, label: string): OmpUsageReport => ({
            provider,
            fetchedAt: 0,
            account: { label },
            limits: [],
        });
        const groups = groupReportsByProvider([
            report('openai-codex', 'free@x.com'),
            report('zai', 'acct'),
            report('openai-codex', 'pro@x.com'),
        ]);
        expect(groups.map((group) => group.provider)).toEqual(['openai-codex', 'zai']);
        expect(groups[0]!.reports.map((entry) => entry.account.label)).toEqual(['free@x.com', 'pro@x.com']);
    });
});

describe('providerDisplayName', () => {
    it('uses known spellings', () => {
        expect(providerDisplayName('openai-codex')).toBe('OpenAI Codex');
        expect(providerDisplayName('zai')).toBe('Z AI');
        expect(providerDisplayName('google-antigravity')).toBe('Google Antigravity');
    });

    it('title-cases unknown providers', () => {
        expect(providerDisplayName('some_new-thing')).toBe('Some New Thing');
    });
});

describe('formatDayLabel', () => {
    const labels = { today: 'Today', yesterday: 'Yesterday' };
    const at = (dayOffset: number, hour = 12) => {
        const date = new Date(2026, 8, 26, hour, 0, 0);
        date.setDate(date.getDate() - dayOffset);
        return date.getTime();
    };

    it('names today and yesterday', () => {
        expect(formatDayLabel(at(0), at(0), labels)).toBe('Today');
        expect(formatDayLabel(at(1), at(0), labels)).toBe('Yesterday');
    });

    it('uses a weekday inside the week and a date beyond it', () => {
        const now = at(0);
        expect(new Date(at(3)).toLocaleDateString(undefined, { weekday: 'short' }))
            .toBe(formatDayLabel(at(3), now, labels));
        expect(formatDayLabel(at(20), now, labels))
            .toBe(new Date(at(20)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    });
});
