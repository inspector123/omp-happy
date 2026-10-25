import { resolveAbsolutePath } from './pathUtils';

type HiddenFolderSessionRow = {
    active: boolean;
    path: string | null;
    homeDir: string | null;
};

type HiddenFolderSessionListItem =
    | { type: 'header' }
    | { type: 'active-sessions'; sessions: readonly HiddenFolderSessionRow[] }
    | { type: 'archive-toggle'; hidden: boolean }
    | { type: 'session-search' }
    | { type: 'project-group' }
    | { type: 'session'; session: HiddenFolderSessionRow };

type VisibleSessionListItem<T extends HiddenFolderSessionListItem> =
    | Exclude<T, { type: 'archive-toggle' }>
    | { type: 'archive-toggle'; hidden: boolean };

/**
 * Produces a stable representation for exact folder-path comparisons.
 * Tilde paths are expanded when a home directory is known.
 */
export function normalizeHiddenFolderPath(
    path: string | null | undefined,
    homeDir?: string,
): string {
    const trimmed = path?.trim();
    if (!trimmed) {
        return '';
    }

    const expanded = resolveAbsolutePath(trimmed.replace(/\\/g, '/'), homeDir)
        .replace(/\\/g, '/');
    const normalized = expanded.startsWith('//')
        ? `//${expanded.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
        : expanded.replace(/\/{2,}/g, '/');

    if (normalized === '/' || normalized === '//' || /^[A-Za-z]:\/$/.test(normalized)) {
        return normalized;
    }

    return normalized.replace(/\/+$/, '');
}

export function areHiddenFolderPathsEqual(
    left: string | null | undefined,
    right: string | null | undefined,
    homeDir?: string,
): boolean {
    const normalizedLeft = normalizeHiddenFolderPath(left, homeDir);
    const normalizedRight = normalizeHiddenFolderPath(right, homeDir);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }

    if (
        (/^[A-Za-z]:(?:\/|$)/.test(normalizedLeft) || normalizedLeft.startsWith('//'))
        && (/^[A-Za-z]:(?:\/|$)/.test(normalizedRight) || normalizedRight.startsWith('//'))
    ) {
        return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
    }

    return normalizedLeft === normalizedRight;
}

/**
 * Returns true when the path exactly matches a hidden entry. If a home-relative
 * entry cannot yet be resolved, conservatively defer every nonempty path.
 */
export function isFolderPathHidden(
    path: string | null | undefined,
    homeDir: string | null | undefined,
    hiddenFolderPaths: readonly string[],
): boolean {
    if (!path?.trim()) {
        return false;
    }

    const resolvedHomeDir = homeDir?.trim() || undefined;
    if (
        !resolvedHomeDir
        && hiddenFolderPaths.some((hiddenPath) => /^~(?:[\\/]|$)/.test(hiddenPath.trim()))
    ) {
        return true;
    }

    return hiddenFolderPaths.some(
        (hiddenPath) => areHiddenFolderPathsEqual(path, hiddenPath, resolvedHomeDir),
    );
}

/** Prefers session metadata but supports older sessions through machine metadata. */
export function resolveSessionHomeDir(
    sessionHomeDir: string | null | undefined,
    machineHomeDir: string | null | undefined,
): string | undefined {
    return sessionHomeDir || machineHomeDir || undefined;
}

export function filterVisibleSessionListViewData<T extends HiddenFolderSessionListItem>(
    data: readonly T[] | null,
    hiddenFolderPaths: readonly string[],
    hideInactiveSessions: boolean,
): VisibleSessionListItem<T>[] | null {
    if (!data) {
        return null;
    }

    const result: VisibleSessionListItem<T>[] = [];
    const pushSourceItem = (item: T): void => {
        if (item.type !== 'archive-toggle') {
            result.push(item as Exclude<T, { type: 'archive-toggle' }>);
        }
    };
    let hasVisibleInactive = false;

    for (const item of data) {
        if (item.type === 'active-sessions') {
            const visibleSessions = item.sessions.filter((session) => !isFolderPathHidden(
                session.path,
                session.homeDir,
                hiddenFolderPaths,
            ));
            if (visibleSessions.length > 0) {
                pushSourceItem(
                    visibleSessions.length === item.sessions.length
                        ? item
                        : { ...item, sessions: visibleSessions } as T,
                );
            }
        } else if (
            item.type === 'session'
            && !item.session.active
            && !isFolderPathHidden(item.session.path, item.session.homeDir, hiddenFolderPaths)
        ) {
            hasVisibleInactive = true;
        }
    }

    if (hasVisibleInactive) {
        result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
    }

    if (!hideInactiveSessions) {
        let pendingHeader: T | null = null;
        let pendingProjectGroup: T | null = null;

        for (const item of data) {
            if (item.type === 'active-sessions') {
                continue;
            }

            if (item.type === 'header') {
                pendingHeader = item;
                pendingProjectGroup = null;
                continue;
            }

            if (item.type === 'project-group') {
                pendingProjectGroup = item;
                continue;
            }

            if (
                item.type !== 'session'
                || item.session.active
                || isFolderPathHidden(item.session.path, item.session.homeDir, hiddenFolderPaths)
            ) {
                continue;
            }

            if (pendingHeader) {
                pushSourceItem(pendingHeader);
                pendingHeader = null;
            }
            if (pendingProjectGroup) {
                pushSourceItem(pendingProjectGroup);
                pendingProjectGroup = null;
            }
            pushSourceItem(item);
        }
    }

    return result;
}
