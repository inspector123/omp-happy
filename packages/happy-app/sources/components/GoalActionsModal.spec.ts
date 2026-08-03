import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GoalActionsModal } from './GoalActionsModal';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Pressable: ({ children, ...props }: Record<string, any>) => React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: Record<string, any>) => React.createElement('Text', props, children),
    View: ({ children, ...props }: Record<string, any>) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#444444',
                radio: { active: '#0088ff' },
                surface: '#202020',
                surfacePressed: '#303030',
                text: '#ffffff',
                textSecondary: '#a0a0a0',
            },
        },
    }),
}));

type ElementWithProps = React.ReactElement<Record<string, any>>;

function childrenOf(node: React.ReactNode): React.ReactNode[] {
    if (!React.isValidElement(node)) {
        return [];
    }
    return React.Children.toArray((node as ElementWithProps).props.children);
}

function findByLabel(node: React.ReactNode, label: string): ElementWithProps | null {
    if (!React.isValidElement(node)) {
        return null;
    }
    const element = node as ElementWithProps;
    if (element.props.accessibilityLabel === label) {
        return element;
    }
    for (const child of childrenOf(element)) {
        const match = findByLabel(child, label);
        if (match) {
            return match;
        }
    }
    return null;
}

describe('GoalActionsModal', () => {
    it('offers every native OMP goal action', () => {
        const modal = GoalActionsModal({ onClose: vi.fn(), onAction: vi.fn() });

        expect(findByLabel(modal, 'Set: Set or replace the goal')).not.toBeNull();
        expect(findByLabel(modal, 'Show: Show current goal details')).not.toBeNull();
        expect(findByLabel(modal, 'Pause: Pause the current goal')).not.toBeNull();
        expect(findByLabel(modal, 'Resume: Resume a paused goal')).not.toBeNull();
        expect(findByLabel(modal, 'Drop: Drop the current goal')).not.toBeNull();
    });

    it('closes before dispatching the selected action', () => {
        const calls: string[] = [];
        const modal = GoalActionsModal({
            onClose: () => calls.push('close'),
            onAction: (action) => calls.push(action),
        });
        const pause = findByLabel(modal, 'Pause: Pause the current goal');

        pause?.props.onPress();

        expect(calls).toEqual(['close', 'pause']);
    });
});
