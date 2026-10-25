import type { Machine } from '@/sync/storageTypes';

export function isMachineOnline(machine: Machine): boolean {
    // Use the active flag directly, no timeout checks
    return machine.active;
}

export function machineDisplayName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}