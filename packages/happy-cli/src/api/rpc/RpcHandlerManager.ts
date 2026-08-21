/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';

const RPC_REGISTRATION_RETRY_MS = 1_000;
const RPC_REGISTRATION_REFRESH_MS = 30_000;

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private socket: Socket | null = null;
    private acknowledgedMethods = new Set<string>();
    private registrationTimer: NodeJS.Timeout | null = null;

    private readonly onRpcRegistered = (data: { method?: unknown }): void => {
        if (typeof data?.method !== 'string' || !this.handlers.has(data.method)) {
            return;
        }
        this.acknowledgedMethods.add(data.method);
        this.scheduleRegistration();
    };

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);
        this.handlers.set(prefixedMethod, handler);
        this.acknowledgedMethods.delete(prefixedMethod);

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
            this.scheduleRegistration();
        }
    }

    unregisterHandler(method: string): void {
        const prefixedMethod = this.getPrefixedMethod(method);
        this.handlers.delete(prefixedMethod);
        this.acknowledgedMethods.delete(prefixedMethod);

        if (this.socket) {
            this.socket.emit('rpc-unregister', { method: prefixedMethod });
            this.scheduleRegistration();
        }
    }
    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: 'Method not found' };
                const encryptedError = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
                return encryptedError;
            }

            // Decrypt the incoming params
            const decryptedParams = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params));

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            const result = await handler(decryptedParams);
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const encryptedResponse = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, result));
            this.logger('[RPC] Sending encrypted response', { method: request.method, responseLength: encryptedResponse.length });
            return encryptedResponse;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        }
    }

    onSocketConnect(socket: Socket): void {
        this.detachSocket();
        this.socket = socket;
        this.acknowledgedMethods.clear();
        socket.on('rpc-registered', this.onRpcRegistered);
        this.emitRegistrations();
        this.scheduleRegistration();
    }

    onSocketDisconnect(): void {
        this.detachSocket();
    }

    private emitRegistrations(): void {
        if (!this.socket) {
            return;
        }
        for (const [prefixedMethod] of this.handlers) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    private scheduleRegistration(): void {
        if (this.registrationTimer) {
            clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }
        if (!this.socket || this.handlers.size === 0) {
            return;
        }

        const allAcknowledged = this.acknowledgedMethods.size === this.handlers.size;
        const delay = allAcknowledged
            ? RPC_REGISTRATION_REFRESH_MS
            : RPC_REGISTRATION_RETRY_MS;
        this.registrationTimer = setTimeout(() => {
            this.registrationTimer = null;
            this.acknowledgedMethods.clear();
            this.emitRegistrations();
            this.scheduleRegistration();
        }, delay);
        this.registrationTimer.unref();
    }

    private detachSocket(): void {
        if (this.registrationTimer) {
            clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
        }
        if (this.socket) {
            this.socket.off('rpc-registered', this.onRpcRegistered);
            this.socket = null;
        }
        this.acknowledgedMethods.clear();
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.acknowledgedMethods.clear();
        this.scheduleRegistration();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
