import type { OmpUsageLimit, OmpUsageReport } from '@/sync/apiOmpUsage';

/**
 * Presentation helpers for the Usage screen. Kept free of React and of
 * translation calls so the number/label logic is directly testable; the
 * components pass translated words in where needed.
 */

export type UsageSeverity = 'ok' | 'warning' | 'critical' | 'unknown';

const CRITICAL_FRACTION = 0.9;
const WARNING_FRACTION = 0.7;

/**
 * Fraction of a quota window that is spent (0..1, above 1 means overage).
 * Same precedence native OMP uses in its own usage UIs: explicit fraction,
 * then used/limit, then a percent `used`, then inverted remaining.
 */
export function resolveUsedFraction(limit: OmpUsageLimit): number | undefined {
    if (typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)) return limit.usedFraction;
    if (typeof limit.used === 'number' && typeof limit.limit === 'number' && limit.limit > 0) {
        return limit.used / limit.limit;
    }
    if (limit.unit === 'percent' && typeof limit.used === 'number') return limit.used / 100;
    if (typeof limit.remainingFraction === 'number' && Number.isFinite(limit.remainingFraction)) {
        return Math.max(0, 1 - limit.remainingFraction);
    }
    return undefined;
}

export function usageSeverity(fraction: number | undefined): UsageSeverity {
    if (fraction === undefined) return 'unknown';
    if (fraction >= CRITICAL_FRACTION) return 'critical';
    if (fraction >= WARNING_FRACTION) return 'warning';
    return 'ok';
}

function trimFraction(value: number, digits: number): string {
    const rounded = Number(value.toFixed(digits));
    return String(rounded);
}

function groupNumber(value: number): string {
    return trimFraction(value, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 1234 → "1,234", 45678 → "45.7K", 3_400_000 → "3.4M". */
export function formatCompactNumber(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${trimFraction(value / 1_000_000_000, 2)}B`;
    if (abs >= 1_000_000) return `${trimFraction(value / 1_000_000, 2)}M`;
    if (abs >= 10_000) return `${trimFraction(value / 1_000, 1)}K`;
    return groupNumber(value);
}

/** "$0", "$0.42", "$0.0031", "$2,015.84". */
export function formatCost(usd: number): string {
    if (!Number.isFinite(usd) || usd === 0) return '$0';
    const abs = Math.abs(usd);
    if (abs >= 1) return `$${trimFraction(usd, 2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    if (abs < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

/** "3d 4h", "6h 12m", "42m", "<1m". */
export function formatCountdown(msRemaining: number): string {
    if (!Number.isFinite(msRemaining) || msRemaining <= 0) return '<1m';
    const totalMinutes = Math.floor(msRemaining / 60_000);
    const days = Math.floor(totalMinutes / 1_440);
    const hours = Math.floor((totalMinutes % 1_440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return '<1m';
}

const UNIT_SUFFIXES: Record<string, string> = {
    credits: 'credits',
    tokens: 'tokens',
    requests: 'requests',
    minutes: 'min',
    bytes: 'B',
};

function withUnit(value: string, unit: string): string {
    const suffix = UNIT_SUFFIXES[unit];
    return suffix ? `${value} ${suffix}` : value;
}

/**
 * Spent amount for a quota window: "11%" for percent quotas, otherwise the
 * absolute amount against its cap, e.g. "28,273 / 60,000 credits".
 */
export function formatUsedAmount(limit: OmpUsageLimit): string | undefined {
    const fraction = resolveUsedFraction(limit);
    if (limit.unit === 'percent') {
        if (fraction === undefined) return undefined;
        return `${trimFraction(fraction * 100, 1)}%`;
    }
    if (typeof limit.used === 'number') {
        const used = groupNumber(limit.used);
        return typeof limit.limit === 'number'
            ? withUnit(`${used} / ${groupNumber(limit.limit)}`, limit.unit)
            : withUnit(used, limit.unit);
    }
    if (fraction === undefined) return undefined;
    return `${trimFraction(fraction * 100, 1)}%`;
}

/** Amount still available: "89%", or "31,726 credits". */
export function formatRemainingAmount(limit: OmpUsageLimit): string | undefined {
    if (limit.unit === 'percent') {
        const fraction = resolveUsedFraction(limit);
        if (fraction === undefined) return undefined;
        return `${trimFraction(Math.max(0, 1 - fraction) * 100, 1)}%`;
    }
    if (typeof limit.remaining === 'number') return withUnit(groupNumber(limit.remaining), limit.unit);
    if (typeof limit.used === 'number' && typeof limit.limit === 'number') {
        return withUnit(groupNumber(Math.max(0, limit.limit - limit.used)), limit.unit);
    }
    if (typeof limit.remainingFraction === 'number') {
        return `${trimFraction(Math.max(0, limit.remainingFraction) * 100, 1)}%`;
    }
    return undefined;
}

/**
 * Limit heading with tier and window qualifiers, skipping a qualifier the
 * label already contains (Anthropic's "Claude 7 Day (Fable)" already names its
 * tier, Google Antigravity's "Weekly" already names its window).
 */
export function limitTitle(limit: OmpUsageLimit): string {
    const normalizedLabel = limit.label.toLowerCase();
    const tier = limit.tier && !normalizedLabel.includes(limit.tier.toLowerCase()) ? ` (${limit.tier})` : '';
    const window = limit.windowLabel && !normalizedLabel.includes(limit.windowLabel.toLowerCase())
        ? ` · ${limit.windowLabel}`
        : '';
    return `${limit.label}${tier}${window}`;
}

/**
 * Providers report one entry per routing path for a single upstream quota
 * (identical `sharedGroup`, sometimes byte-identical rows). Show the most
 * spent copy once instead of a wall of duplicates.
 */
export function collapseSharedLimits(limits: OmpUsageLimit[]): OmpUsageLimit[] {
    const order: string[] = [];
    const best = new Map<string, OmpUsageLimit>();
    for (const limit of limits) {
        const key = limit.sharedGroup ?? `${limit.label.toLowerCase()}|${limit.windowId ?? ''}`;
        const existing = best.get(key);
        if (!existing) {
            best.set(key, limit);
            order.push(key);
            continue;
        }
        if ((resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(existing) ?? -1)) {
            best.set(key, limit);
        }
    }
    return order.map((key) => best.get(key)!);
}

export interface ProviderReportGroup {
    provider: string;
    reports: OmpUsageReport[];
}

export function groupReportsByProvider(reports: OmpUsageReport[]): ProviderReportGroup[] {
    const order: string[] = [];
    const grouped = new Map<string, OmpUsageReport[]>();
    for (const report of reports) {
        const existing = grouped.get(report.provider);
        if (existing) {
            existing.push(report);
        } else {
            grouped.set(report.provider, [report]);
            order.push(report.provider);
        }
    }
    return order.map((provider) => ({ provider, reports: grouped.get(provider)! }));
}

/** "openai-codex" → "OpenAI Codex", "zai" → "Z AI". */
const PROVIDER_NAMES: Record<string, string> = {
    'openai-codex': 'OpenAI Codex',
    'google-antigravity': 'Google Antigravity',
    zai: 'Z AI',
    'zlocal': 'zlocal',
    'zlocal-glm': 'zlocal-glm',
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'gemini': 'Gemini',
    'github-copilot': 'GitHub Copilot',
    'kimi-code': 'Kimi Code',
    'deepseek': 'DeepSeek',
    'mistral': 'Mistral',
    'xai': 'xAI',
    'groq': 'Groq',
};

export function providerDisplayName(provider: string): string {
    const known = PROVIDER_NAMES[provider.toLowerCase()];
    if (known) return known;
    return provider
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

/** "Today" / "Yesterday" / "Mon" / "Sep 21", translated words injected by the caller. */
export function formatDayLabel(
    timestamp: number,
    now: number,
    labels: { today: string; yesterday: string },
): string {
    const startOfDay = (value: number) => {
        const date = new Date(value);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    };
    const dayStart = startOfDay(timestamp);
    if (dayStart === startOfDay(now)) return labels.today;
    const previousDay = new Date(now);
    previousDay.setHours(0, 0, 0, 0);
    previousDay.setDate(previousDay.getDate() - 1);
    if (dayStart === previousDay.getTime()) return labels.yesterday;
    const withinWeek = now - dayStart < 6 * 86_400_000;
    if (withinWeek) return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'short' });
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "just now", "42s ago", "7m ago", "3h ago", "5d ago". */
export function formatAgo(elapsedMs: number): string {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000) return 'just now';
    const totalSeconds = Math.floor(elapsedMs / 1_000);
    if (totalSeconds < 60) return `${totalSeconds}s ago`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m ago`;
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) return `${totalHours}h ago`;
    return `${Math.floor(totalHours / 24)}d ago`;
}
