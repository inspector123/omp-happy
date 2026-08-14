import { describe, expect, it, vi } from 'vitest';
import { resolveSessionActivity } from './sessionPresence';

describe('session presence', () => {
    it('does not restore a stale server active flag as online after app restart', () => {
        vi.setSystemTime(new Date('2026-08-14T15:00:00.000Z'));
        const activeAt = Date.now() - 11 * 60 * 1000;
        const session = { active: true, activeAt };

        expect(resolveSessionActivity(session)).toEqual({ active: false, presence: activeAt });
    });

    it('keeps a recently active session online', () => {
        vi.setSystemTime(new Date('2026-08-14T15:00:00.000Z'));
        const session = { active: true, activeAt: Date.now() - 30_000 };

        expect(resolveSessionActivity(session)).toEqual({ active: true, presence: 'online' });
    });

    it('keeps an explicitly inactive session offline', () => {
        const activeAt = Date.now();
        const session = { active: false, activeAt };

        expect(resolveSessionActivity(session)).toEqual({ active: false, presence: activeAt });
    });
});
