import { z } from 'zod';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { collectOmpUsage } from './ompUsage';

/**
 * Machine RPC entry point for the companion app's Usage screen: reads native
 * OMP's provider quota reports and token/cost rollup on this machine.
 */
const usageRequestSchema = z.object({
    range: z.enum(['today', '7d', '30d']).default('today'),
    /** Ask OMP to re-parse session files before reading the token rollup. */
    resync: z.boolean().default(false),
});

export function registerOmpUsageHandler(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler('omp-usage', async (params: unknown) => {
        const request = usageRequestSchema.parse(params ?? {});
        logger.debug(`[OMP usage] Collecting ${request.range} usage (resync=${request.resync})`);
        const snapshot = await collectOmpUsage({ range: request.range, resync: request.resync });
        logger.debug(
            `[OMP usage] ${request.range}: ${snapshot.limits?.reports.length ?? 0} reports, `
            + `${snapshot.tokens?.byModel.length ?? 0} models, ${snapshot.errors.length} problems`
            + `${snapshot.refreshing ? ', provider fetch still running' : ''}`
            + `${snapshot.syncing ? ', resync running' : ''}`,
        );
        return snapshot;
    });
}
