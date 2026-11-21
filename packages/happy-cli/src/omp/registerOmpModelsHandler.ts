import { z } from 'zod';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { collectOmpModels } from './ompModels';

/**
 * Machine RPC entry point for the app's model pickers. Returns the last OMP
 * catalog snapshot immediately and refreshes it in the background: the
 * catalog listing takes about 60 s on this machine, and the server aborts any
 * machine RPC that runs longer than 30 s.
 */
const modelsRequestSchema = z.object({
    /** Ignore the cached snapshot and start a refresh. */
    force: z.boolean().default(false),
});

export function registerOmpModelsHandler(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler('omp-models', async (params: unknown) => {
        const request = modelsRequestSchema.parse(params ?? {});
        const snapshot = await collectOmpModels({ force: request.force });
        logger.debug(
            `[OMP models] ${snapshot.models.length} models`
            + `${snapshot.refreshing ? ', catalog refresh running' : ''}`
            + `${snapshot.error ? `, error: ${snapshot.error}` : ''}`,
        );
        return snapshot;
    });
}
