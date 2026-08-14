import { describe, expect, it } from 'vitest';
import { isSessionActivityCurrent, PRESENCE_TIMEOUT_MS } from './sessionActivity';

const NOW = Date.parse('2026-08-14T15:00:00.000Z');

describe('isSessionActivityCurrent', () => {
    it('returns false for an active database record with an expired heartbeat', () => {
        expect(isSessionActivityCurrent({
            active: true,
            lastActiveAt: new Date(NOW - PRESENCE_TIMEOUT_MS),
        }, NOW)).toBe(false);
    });

    it('returns true while the heartbeat is current', () => {
        expect(isSessionActivityCurrent({
            active: true,
            lastActiveAt: new Date(NOW - PRESENCE_TIMEOUT_MS + 1),
        }, NOW)).toBe(true);
    });

    it('returns false when the database record is explicitly inactive', () => {
        expect(isSessionActivityCurrent({
            active: false,
            lastActiveAt: new Date(NOW),
        }, NOW)).toBe(false);
    });
});
