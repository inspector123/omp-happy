import type { Session } from '@/sync/storageTypes';

export type ClaudeForkSource = {
    kind: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

export type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

/** An OMP chat forks through `omp --fork`, which copies its session file into a new one. */
export type OmpForkSource = {
    kind: 'omp';
    sessionId: string;
    machineId: string;
    directory: string;
    ompSessionId: string;
};

export type ForkSource = ClaudeForkSource | CodexForkSource | OmpForkSource;

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function getSessionForkSource(session: Session): ForkSource | null {
    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    if (!nonEmpty(machineId) || !nonEmpty(directory)) {
        return null;
    }

    if (session.metadata?.flavor === 'codex') {
        const codexThreadId = session.metadata?.codexThreadId;
        if (!nonEmpty(codexThreadId)) {
            return null;
        }
        return {
            kind: 'codex',
            sessionId: session.id,
            machineId,
            directory,
            codexThreadId,
        };
    }

    if (session.metadata?.flavor === 'omp') {
        const ompSessionId = session.metadata?.ompSessionId;
        if (!nonEmpty(ompSessionId)) {
            return null;
        }
        return {
            kind: 'omp',
            sessionId: session.id,
            machineId,
            directory,
            ompSessionId,
        };
    }

    const claudeSessionId = session.metadata?.claudeSessionId;
    if (!nonEmpty(claudeSessionId)) {
        return null;
    }
    return {
        kind: 'claude',
        sessionId: session.id,
        machineId,
        directory,
        claudeSessionId,
    };
}
