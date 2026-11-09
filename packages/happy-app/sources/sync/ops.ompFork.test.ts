import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forkAndSpawn } from './ops';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions },
}));

describe('omp fork ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('spawns a new omp chat that forks the source session, never one that resumes it in place', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-fork' });

        const result = await forkAndSpawn({
            kind: 'omp',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            ompSessionId: 'omp-source',
        }, { ompModel: 'zlocal/glm-5.3-flash' });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-fork' });
        expect(machineRPC).toHaveBeenCalledTimes(1);
        const [machineId, method, params] = machineRPC.mock.calls[0];
        expect([machineId, method]).toEqual(['machine-1', 'spawn-happy-session']);
        expect(params).toMatchObject({
            directory: '/tmp/project',
            agent: 'omp',
            forkOmpSessionId: 'omp-source',
            ompModel: 'zlocal/glm-5.3-flash',
            parentSessionId: 'happy-source',
        });
        expect(params.resumeOmpSessionId).toBeUndefined();
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });
});
