export type ContextTelemetry = {
    contextSize: number;
    contextWindow?: number;
    contextPercent?: number;
    tokensPerSecond?: number;
};

function trimSingleDecimal(value: number): string {
    const formatted = value.toFixed(1);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
}

function formatCompactNumber(value: number): string {
    if (value < 1_000) return value.toString();
    if (value < 10_000) return `${trimSingleDecimal(value / 1_000)}K`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
    if (value < 10_000_000) return `${trimSingleDecimal(value / 1_000_000)}M`;
    if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`;
    if (value < 10_000_000_000) return `${trimSingleDecimal(value / 1_000_000_000)}B`;
    return `${Math.round(value / 1_000_000_000)}B`;
}

export function resolveContextPercent(
    telemetry: ContextTelemetry,
    fallbackContextWindow?: number,
): number | null {
    if (
        telemetry.contextPercent !== undefined
        && Number.isFinite(telemetry.contextPercent)
        && telemetry.contextPercent >= 0
    ) {
        return telemetry.contextPercent;
    }

    const contextWindow = telemetry.contextWindow !== undefined
        && Number.isFinite(telemetry.contextWindow)
        && telemetry.contextWindow > 0
        ? telemetry.contextWindow
        : fallbackContextWindow;
    if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return null;
    }

    return (telemetry.contextSize / contextWindow) * 100;
}

export function formatOmpContextStatus(telemetry: ContextTelemetry): string {
    const contextWindow = telemetry.contextWindow !== undefined
        && Number.isFinite(telemetry.contextWindow)
        && telemetry.contextWindow > 0
        ? telemetry.contextWindow
        : null;
    const contextPercent = resolveContextPercent(telemetry);
    const context = contextWindow !== null
        ? `${contextPercent === null ? '?' : `${contextPercent.toFixed(1)}%`}/${formatCompactNumber(contextWindow)}`
        : `${formatCompactNumber(telemetry.contextSize)}/?`;
    const tokensPerSecond = telemetry.tokensPerSecond;
    return tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
        ? `${context} • ${tokensPerSecond.toFixed(1)} tok/s`
        : context;
}
