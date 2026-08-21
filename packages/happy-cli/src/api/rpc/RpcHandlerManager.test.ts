import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { RpcHandlerManager } from './RpcHandlerManager';

type Listener = (data: unknown) => void;

class FakeSocket {
    readonly emitted: Array<{ event: string; data: unknown }> = [];
    private readonly listeners = new Map<string, Set<Listener>>();

    emit(event: string, data: unknown): void {
        this.emitted.push({ event, data });
    }

    on(event: string, listener: Listener): void {
        const listeners = this.listeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    off(event: string, listener: Listener): void {
        this.listeners.get(event)?.delete(listener);
    }

    receive(event: string, data: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(data);
        }
    }

    registrationCount(method: string): number {
        return this.emitted.filter((entry) => (
            entry.event === 'rpc-register'
            && typeof entry.data === 'object'
            && entry.data !== null
            && 'method' in entry.data
            && entry.data.method === method
        )).length;
    }
}

function createManager(): RpcHandlerManager {
    return new RpcHandlerManager({
        scopePrefix: 'session-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        logger: vi.fn(),
    });
}

function connect(manager: RpcHandlerManager, socket: FakeSocket): void {
    // FakeSocket implements only the Socket methods exercised by the manager.
    manager.onSocketConnect(socket as unknown as Socket);
}

describe('RpcHandlerManager registration reliability', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries a dropped registration, then refreshes an acknowledged registration', async () => {
        const manager = createManager();
        const socket = new FakeSocket();
        manager.registerHandler('set-model', async () => ({ success: true }));

        connect(manager, socket);
        expect(socket.registrationCount('session-1:set-model')).toBe(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(socket.registrationCount('session-1:set-model')).toBe(2);

        socket.receive('rpc-registered', { method: 'session-1:set-model' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(socket.registrationCount('session-1:set-model')).toBe(2);

        await vi.advanceTimersByTimeAsync(29_000);
        expect(socket.registrationCount('session-1:set-model')).toBe(3);
    });

    it('stops registration timers after disconnect', async () => {
        const manager = createManager();
        const socket = new FakeSocket();
        manager.registerHandler('set-model', async () => ({ success: true }));
        connect(manager, socket);

        manager.onSocketDisconnect();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(socket.registrationCount('session-1:set-model')).toBe(1);
    });
});
