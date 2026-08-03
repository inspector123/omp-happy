import { Typography } from '@/constants/Typography';
import type { OmpGoalAction } from './parseLocalCommandMessage';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

const GOAL_ACTIONS: Array<{
    action: OmpGoalAction;
    label: string;
    description: string;
}> = [
    { action: 'set', label: 'Set', description: 'Set or replace the goal' },
    { action: 'show', label: 'Show', description: 'Show current goal details' },
    { action: 'pause', label: 'Pause', description: 'Pause the current goal' },
    { action: 'resume', label: 'Resume', description: 'Resume a paused goal' },
    { action: 'drop', label: 'Drop', description: 'Drop the current goal' },
];

export function GoalActionsModal(props: {
    onClose: () => void;
    onAction: (action: OmpGoalAction) => void;
}) {
    const { theme } = useUnistyles();

    return (
        <View style={{
            width: 320,
            maxWidth: '90%',
            borderRadius: 16,
            overflow: 'hidden',
            backgroundColor: theme.colors.surface,
        }}>
            <Text style={{
                paddingHorizontal: 20,
                paddingTop: 18,
                paddingBottom: 12,
                fontSize: 18,
                color: theme.colors.text,
                ...Typography.default('semiBold'),
            }}>
                Goal
            </Text>
            {GOAL_ACTIONS.map((item) => (
                <Pressable
                    key={item.action}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.label}: ${item.description}`}
                    onPress={() => {
                        props.onClose();
                        props.onAction(item.action);
                    }}
                    style={({ pressed }) => ({
                        paddingHorizontal: 20,
                        paddingVertical: 12,
                        borderTopWidth: 1,
                        borderTopColor: theme.colors.divider,
                        backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                    })}
                >
                    <Text style={{
                        fontSize: 15,
                        color: theme.colors.text,
                        ...Typography.default('semiBold'),
                    }}>
                        {item.label}
                    </Text>
                    <Text style={{
                        marginTop: 2,
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}>
                        {item.description}
                    </Text>
                </Pressable>
            ))}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                onPress={props.onClose}
                style={({ pressed }) => ({
                    paddingVertical: 14,
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.divider,
                    backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface,
                    alignItems: 'center',
                })}
            >
                <Text style={{
                    fontSize: 14,
                    color: theme.colors.radio.active,
                    ...Typography.default('semiBold'),
                }}>
                    Cancel
                </Text>
            </Pressable>
        </View>
    );
}
