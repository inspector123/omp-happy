import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => {
    const memo = (component: unknown) => component;
    return { memo, default: { memo } };
});

vi.mock('react-native', () => ({
    View: () => null,
    Text: () => null,
    TouchableOpacity: () => null,
    ActivityIndicator: () => null,
    Platform: { OS: 'ios' },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: () => ({}) },
    useUnistyles: () => ({ theme: { colors: {} } }),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../../tools/ToolSectionView', () => ({ ToolSectionView: () => null }));
vi.mock('@/components/CodeView', () => ({ CodeView: () => null }));

import { getSubagentStatusSortRank } from './DelegateView';

describe('getSubagentStatusSortRank', () => {
    it('sorts open work before terminal work and completed work last', () => {
        const statuses = ['completed', 'failed', 'pending', 'aborted', 'running', 'queued'];

        expect(statuses.sort((left, right) => (
            getSubagentStatusSortRank(left) - getSubagentStatusSortRank(right)
        ))).toEqual(['pending', 'running', 'queued', 'failed', 'aborted', 'completed']);
    });
});
