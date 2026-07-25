import * as React from 'react';
import { SessionListViewItem, useLocalSetting, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterVisibleSessionListViewData } from '@/utils/hiddenFolders';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const hiddenFolderPaths = useLocalSetting('hiddenFolderPaths');

    return React.useMemo(
        () => filterVisibleSessionListViewData(
            data,
            hiddenFolderPaths,
            hideInactiveSessions,
        ),
        [data, hiddenFolderPaths, hideInactiveSessions],
    );
}
