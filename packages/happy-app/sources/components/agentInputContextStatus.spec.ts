import { describe, expect, it } from 'vitest';
import { formatOmpContextStatus, resolveContextPercent } from './agentInputContextStatus';

describe('agent input context status', () => {
    it('formats OMP context as used percent over the model window with live speed', () => {
        expect(formatOmpContextStatus({
            contextSize: 60_000,
            contextWindow: 200_000,
            contextPercent: 32.456,
            tokensPerSecond: 18.25,
        })).toBe('32.5%/200K • 18.3 tok/s');
    });

    it.each([0, -1])('omits token speed when it is not live (%s)', (tokensPerSecond) => {
        expect(formatOmpContextStatus({
            contextSize: 60_000,
            contextWindow: 200_000,
            contextPercent: 32.456,
            tokensPerSecond,
        })).toBe('32.5%/200K');
    });

    it('prefers the real model window and preserves the legacy fallback when it is absent', () => {
        const telemetry = {
            contextSize: 95_000,
            contextWindow: 500_000,
        };

        expect(resolveContextPercent(telemetry, 190_000)).toBeCloseTo(19);
        expect(formatOmpContextStatus(telemetry)).toBe('19.0%/500K');
        expect(resolveContextPercent({ contextSize: 95_000 }, 190_000)).toBe(50);
    });

    it('uses the token count when the model window is unknown', () => {
        expect(formatOmpContextStatus({
            contextSize: 27_929,
            contextWindow: 0,
            contextPercent: 0,
        })).toBe('28K/?');
    });
});
