import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

/**
 * OMP arguments that choose the conversation and model a daemon-spawned `happy omp` session
 * starts with. A fork takes precedence over a resume: forking copies the source session, so the
 * source stays untouched, while resuming would continue it in place.
 */
export function buildOmpSessionArgs(
    options: Pick<SpawnSessionOptions, 'resumeOmpSessionId' | 'forkOmpSessionId' | 'ompModel'>,
): string[] {
    const args: string[] = [];
    if (options.forkOmpSessionId) {
        args.push('--fork', options.forkOmpSessionId);
    } else if (options.resumeOmpSessionId) {
        args.push('--resume', options.resumeOmpSessionId);
    }
    if (options.ompModel) {
        args.push('--model', options.ompModel);
    }
    return args;
}
