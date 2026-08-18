import { afterEach, describe, expect, it, vi } from 'vitest';
import { exponentialBackoffDelay } from './time';

describe('exponentialBackoffDelay', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('backs off exponentially and caps the retry window', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);

        expect(exponentialBackoffDelay(0, 250, 30_000, 50)).toBe(250);
        expect(exponentialBackoffDelay(1, 250, 30_000, 50)).toBe(500);
        expect(exponentialBackoffDelay(2, 250, 30_000, 50)).toBe(1_000);
        expect(exponentialBackoffDelay(20, 250, 30_000, 50)).toBe(30_000);
    });

    it('never schedules a retry sooner than the minimum delay', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        expect(exponentialBackoffDelay(20, 250, 30_000, 50)).toBe(250);
    });
});
