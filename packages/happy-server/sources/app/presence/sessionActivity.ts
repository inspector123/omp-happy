export const PRESENCE_TIMEOUT_MS = 10 * 60 * 1000;

export type PersistedSessionActivity = {
    active: boolean;
    lastActiveAt: Date;
};

export function isSessionActivityCurrent(
    session: PersistedSessionActivity,
    now = Date.now(),
): boolean {
    return session.active && session.lastActiveAt.getTime() > now - PRESENCE_TIMEOUT_MS;
}
