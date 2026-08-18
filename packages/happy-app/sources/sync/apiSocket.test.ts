import { describe, expect, it, vi } from 'vitest';
import { shouldConnectSyncSocket } from './apiSocket';

vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Platform: { OS: 'web' },
}));
vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '1.0.0' } },
}));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {},
}));
vi.mock('./storage', () => ({
    storage: { getState: () => ({ localSettings: { verboseLogging: false } }) },
}));

describe('shouldConnectSyncSocket', () => {
    it('keeps mobile realtime connections only while the app is active', () => {
        expect(shouldConnectSyncSocket('active', 'android')).toBe(true);
        expect(shouldConnectSyncSocket('inactive', 'android')).toBe(false);
        expect(shouldConnectSyncSocket('background', 'android')).toBe(false);
        expect(shouldConnectSyncSocket('active', 'ios')).toBe(true);
        expect(shouldConnectSyncSocket('background', 'ios')).toBe(false);
    });

    it('keeps web and desktop connections available across visibility changes', () => {
        expect(shouldConnectSyncSocket('active', 'web')).toBe(true);
        expect(shouldConnectSyncSocket('background', 'web')).toBe(true);
    });
});
