export type SessionActivity = {
    active: boolean;
    activeAt: number;
};

// The server marks sessions inactive after ten minutes without a heartbeat.
// Apply the same rule while hydrating so a stale persisted `active` flag cannot
// put a dead session back into the active group after an app restart.
export const SESSION_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;

export function isSessionActive(session: SessionActivity, now = Date.now()): boolean {
    return session.active && session.activeAt > now - SESSION_ACTIVE_TIMEOUT_MS;
}

export function resolveSessionActivity(
    session: SessionActivity,
    now = Date.now(),
): { active: boolean; presence: "online" | number } {
    const active = isSessionActive(session, now);
    return {
        active,
        presence: active ? "online" : session.activeAt,
    };
}
