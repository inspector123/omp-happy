import { describe, expect, it } from 'vitest';
import {
    filterVisibleSessionListViewData,
    isFolderPathHidden,
    normalizeHiddenFolderPath,
    resolveSessionHomeDir,
} from './hiddenFolders';

describe('hidden folders', () => {
    it('normalizes separators and preserves UNC prefixes', () => {
        expect(normalizeHiddenFolderPath('  /home/user/project///  ')).toBe('/home/user/project');
        expect(normalizeHiddenFolderPath('C:\\Users\\user\\project\\')).toBe('C:/Users/user/project');
        expect(normalizeHiddenFolderPath('//server///share//project///')).toBe('//server/share/project');
        expect(normalizeHiddenFolderPath('\\\\server\\share\\project\\')).toBe('//server/share/project');
        expect(normalizeHiddenFolderPath('/')).toBe('/');
        expect(normalizeHiddenFolderPath('C:\\')).toBe('C:/');
    });

    it('matches exact absolute and home-relative paths', () => {
        expect(isFolderPathHidden('/home/user/private', '/home/user', ['~/private'])).toBe(true);
        expect(isFolderPathHidden('/home/user/private/', '/home/user', ['/home/user/private'])).toBe(true);
        expect(isFolderPathHidden('/home/user/private/nested', '/home/user', ['~/private'])).toBe(false);
        expect(isFolderPathHidden('/home/user/public', '/home/user', ['~/private'])).toBe(false);
    });

    it('defers nonempty paths while home-relative rules cannot be resolved', () => {
        for (const hiddenPath of ['~', '~/private', '~\\private']) {
            expect(isFolderPathHidden('/home/ada/public', undefined, [hiddenPath])).toBe(true);
        }
        expect(isFolderPathHidden('', undefined, ['~/private'])).toBe(false);
    });

    it('resumes exact home-relative matching after home metadata arrives', () => {
        expect(isFolderPathHidden('/home/ada/private', undefined, ['~/private'])).toBe(true);
        expect(isFolderPathHidden('/home/ada/private', '/home/ada', ['~/private'])).toBe(true);
        expect(isFolderPathHidden('/home/ada/public', '/home/ada', ['~/private'])).toBe(false);
    });

    it('matches absolute-only rules normally without home metadata', () => {
        expect(isFolderPathHidden('/srv/private', undefined, ['/srv/private'])).toBe(true);
        expect(isFolderPathHidden('/srv/public', undefined, ['/srv/private'])).toBe(false);
    });

    it('filters older session rows until home-relative rules can be resolved', () => {
        const unresolvedActive = {
            active: true,
            path: '/home/ada/public',
            homeDir: null,
        };
        const unresolvedInactive = {
            active: false,
            path: '/home/ada/public',
            homeDir: null,
        };
        const data = [
            { type: 'active-sessions' as const, sessions: [unresolvedActive] },
            { type: 'header' as const, title: 'Today' },
            { type: 'project-group' as const, displayPath: '~/public' },
            { type: 'session' as const, session: unresolvedInactive },
        ];

        expect(filterVisibleSessionListViewData(data, ['~/private'], false)).toEqual([]);
    });

    it('compares Windows drive and UNC paths case-insensitively', () => {
        expect(isFolderPathHidden(
            'c:\\users\\ada\\private',
            undefined,
            ['C:/Users/Ada/Private'],
        )).toBe(true);
        expect(isFolderPathHidden(
            '//SERVER/Share/Private',
            undefined,
            ['\\\\server\\share\\private'],
        )).toBe(true);
    });

    it('keeps POSIX paths case-sensitive and distinct from UNC paths', () => {
        expect(isFolderPathHidden('/Users/Ada/Private', undefined, ['/users/ada/private'])).toBe(false);
        expect(isFolderPathHidden('/server/share/private', undefined, ['//server/share/private'])).toBe(false);
        expect(isFolderPathHidden('//server/share/private', undefined, ['/server/share/private'])).toBe(false);
    });

    it('falls back to the machine home when session metadata has no home', () => {
        const homeDir = resolveSessionHomeDir(undefined, 'C:\\Users\\Ada');

        expect(homeDir).toBe('C:\\Users\\Ada');
        expect(isFolderPathHidden('c:/users/ada/private', homeDir, ['~/Private'])).toBe(true);
        expect(resolveSessionHomeDir('/home/session', '/home/machine')).toBe('/home/session');
    });

    it('filters grouped active and inactive rows without orphaning groups', () => {
        const hiddenActive = {
            id: 'hidden-active',
            active: true,
            path: '/home/ada/private',
            homeDir: '/home/ada',
        };
        const visibleActive = {
            id: 'visible-active',
            active: true,
            path: '/home/ada/public',
            homeDir: '/home/ada',
        };
        const hiddenInactive = {
            id: 'hidden-inactive',
            active: false,
            path: '/home/ada/private',
            homeDir: '/home/ada',
        };
        const visibleInactive = {
            id: 'visible-inactive',
            active: false,
            path: '/home/ada/archive',
            homeDir: '/home/ada',
        };
        const data = [
            { type: 'active-sessions' as const, sessions: [hiddenActive, visibleActive] },
            { type: 'header' as const, title: 'Today' },
            { type: 'project-group' as const, displayPath: '~/private' },
            { type: 'session' as const, session: hiddenInactive },
            { type: 'header' as const, title: 'Yesterday' },
            { type: 'project-group' as const, displayPath: '~/archive' },
            { type: 'session' as const, session: visibleInactive },
            { type: 'archive-toggle' as const, hidden: false },
        ];

        const visible = filterVisibleSessionListViewData(data, ['~/private'], false);

        expect(visible).toEqual([
            { type: 'active-sessions', sessions: [visibleActive] },
            { type: 'archive-toggle', hidden: false },
            { type: 'header', title: 'Yesterday' },
            { type: 'project-group', displayPath: '~/archive' },
            { type: 'session', session: visibleInactive },
        ]);
        expect(filterVisibleSessionListViewData(data, ['~/private'], true)).toEqual([
            { type: 'active-sessions', sessions: [visibleActive] },
            { type: 'archive-toggle', hidden: true },
        ]);
    });
});
