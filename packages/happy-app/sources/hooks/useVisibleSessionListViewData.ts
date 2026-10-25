import * as React from 'react';
import { SessionListViewItem, useAllMachines, useLocalSetting, useSessionListViewData, useSetting, type SessionRowData } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { filterVisibleSessionListViewData } from '@/utils/hiddenFolders';
import { machineDisplayName } from '@/utils/machineUtils';

export interface SessionListFilter {
    /** Case-insensitive substring match against session name, path, subtitle and machine name. */
    search: string;
    /** Machine id to restrict the list to, or null for all machines. */
    machineId: string | null;
}

/**
 * Drops sessions that do not match the search text and machine filter.
 * Headers are kept only when a session under them survives, and the active
 * group is dropped when none of its sessions survive.
 */
function filterSessionListViewData(
    data: SessionListViewItem[] | null,
    filter: SessionListFilter,
    machineNames: Readonly<Record<string, string>>,
): SessionListViewItem[] | null {
    if (!data) {
        return null;
    }

    const search = filter.search.trim().toLowerCase();
    const hasSearch = search.length > 0;
    const hasMachine = filter.machineId !== null;
    if (!hasSearch && !hasMachine) {
        return data;
    }

    const matches = (row: SessionRowData): boolean => {
        if (hasMachine && row.machineId !== filter.machineId) {
            return false;
        }
        if (!hasSearch) {
            return true;
        }
        const machineName = row.machineId !== null ? machineNames[row.machineId] : undefined;
        return (
            row.name.toLowerCase().includes(search)
            || row.subtitle.toLowerCase().includes(search)
            || (row.path !== null && row.path.toLowerCase().includes(search))
            || (machineName !== undefined && machineName.toLowerCase().includes(search))
        );
    };

    const result: SessionListViewItem[] = [];
    let pendingHeader: SessionListViewItem | null = null;

    for (const item of data) {
        if (item.type === 'active-sessions') {
            const visibleSessions = item.sessions.filter(matches);
            if (visibleSessions.length > 0) {
                result.push(
                    visibleSessions.length === item.sessions.length
                        ? item
                        : { ...item, sessions: visibleSessions },
                );
            }
            continue;
        }

        if (item.type === 'header') {
            pendingHeader = item;
            continue;
        }

        if (item.type === 'session') {
            if (matches(item.session)) {
                if (pendingHeader) {
                    result.push(pendingHeader);
                    pendingHeader = null;
                }
                result.push(item);
            }
            continue;
        }

        result.push(item);
    }

    return result;
}

/**
 * Machine names for every known machine (offline included), keyed by id.
 * Both the search matcher and the machine chip row use the same labels.
 */
export function useMachineNames(): { machines: Machine[]; machineNames: Record<string, string> } {
    const machines = useAllMachines({ includeOffline: true });
    const machineNames = React.useMemo(() => {
        const names: Record<string, string> = {};
        for (const machine of machines) {
            names[machine.id] = machineDisplayName(machine);
        }
        return names;
    }, [machines]);
    return { machines, machineNames };
}

export function useVisibleSessionListViewData(filter?: SessionListFilter): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const hiddenFolderPaths = useLocalSetting('hiddenFolderPaths');
    const { machineNames } = useMachineNames();

    const search = filter?.search ?? '';
    const machineId = filter?.machineId ?? null;
    const isFiltering = search.trim().length > 0 || machineId !== null;

    const searched = React.useMemo(
        () => filterSessionListViewData(data, { search, machineId }, machineNames),
        [data, search, machineId, machineNames],
    );

    const visible = React.useMemo(
        () => filterVisibleSessionListViewData(
            searched,
            hiddenFolderPaths,
            // While searching or filtering by machine, archived sessions stay
            // visible so matches are findable regardless of the toggle.
            isFiltering ? false : hideInactiveSessions,
        ),
        [searched, hiddenFolderPaths, hideInactiveSessions, isFiltering],
    );

    // The search row sits directly below the archived toggle (or below the
    // active sessions group when the toggle is absent).
    return React.useMemo(() => {
        if (!visible) {
            return null;
        }
        let insertAt = 0;
        for (let i = visible.length - 1; i >= 0; i--) {
            if (visible[i].type === 'archive-toggle' || visible[i].type === 'active-sessions') {
                insertAt = i + 1;
                break;
            }
        }
        const next = [...visible];
        next.splice(insertAt, 0, { type: 'session-search' });
        return next;
    }, [visible]);
}
