import * as React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DelegateView } from '@/components/tools/views/DelegateView';
import { layout } from '@/components/layout';
import { sync } from '@/sync/sync';
import { useSession, useSessionMessages } from '@/sync/storage';
import type { Message } from '@/sync/typesMessage';

type DelegateMessage = Extract<Message, { kind: 'tool-call' }>;

type Delegations = {
    all: DelegateMessage[];
    roots: DelegateMessage[];
};

function isDelegateMessage(message: Message): message is DelegateMessage {
    return message.kind === 'tool-call' && message.tool.name === 'delegate_task';
}

function collectDelegations(messages: Message[]): Delegations {
    const allById = new Map<string, DelegateMessage>();
    const nestedIds = new Set<string>();

    const visit = (message: Message, insideDelegation: boolean) => {
        const isDelegation = isDelegateMessage(message);
        if (isDelegation) {
            allById.set(message.id, message);
            if (insideDelegation) nestedIds.add(message.id);
        }

        if (message.kind === 'tool-call') {
            for (const child of message.children) {
                visit(child, insideDelegation || isDelegation);
            }
        }
    };

    for (const message of messages) visit(message, false);

    const all = Array.from(allById.values());
    return {
        all,
        roots: all.filter((message) => !nestedIds.has(message.id)),
    };
}

function countAssignedAgents(messages: DelegateMessage[]): number {
    return messages.reduce((total, message) => {
        const input = message.tool.input;
        if (!input || typeof input !== 'object' || !('tasks' in input)) return total;
        return total + (Array.isArray(input.tasks) ? input.tasks.length : 0);
    }, 0);
}

function formatStatus(state: DelegateMessage['tool']['state']): string {
    switch (state) {
        case 'running': return 'Active';
        case 'completed': return 'Completed';
        case 'error': return 'Failed';
        default: return 'Pending';
    }
}

export default function SubagentDetailsScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const session = useSession(sessionId!);
    const { messages, isLoaded } = useSessionMessages(sessionId!);
    const { theme } = useUnistyles();
    const delegations = React.useMemo(() => collectDelegations(messages), [messages]);
    const assignedAgentCount = React.useMemo(
        () => countAssignedAgents(delegations.all),
        [delegations.all],
    );
    const activeDelegationCount = delegations.all.filter(
        (message) => message.tool.state === 'running',
    ).length;

    React.useEffect(() => {
        if (sessionId) sync.onSessionVisible(sessionId);
    }, [sessionId]);

    if (!session || !isLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <View style={styles.summary}>
                <View style={styles.summaryIcon}>
                    <Ionicons name="people-outline" size={22} color={theme.colors.text} />
                </View>
                <View style={styles.summaryText}>
                    <Text style={styles.summaryTitle}>
                        {assignedAgentCount} subagent{assignedAgentCount === 1 ? '' : 's'}
                    </Text>
                    <Text style={styles.summarySubtitle}>
                        {activeDelegationCount > 0
                            ? `${activeDelegationCount} active delegation${activeDelegationCount === 1 ? '' : 's'}`
                            : delegations.all.length > 0
                                ? 'No active delegations'
                                : 'No subagents in this session yet'}
                    </Text>
                </View>
            </View>

            {delegations.roots.map((message, index) => (
                <View key={message.id} style={styles.delegationCard}>
                    <View style={styles.delegationHeader}>
                        <Text style={styles.delegationTitle}>Delegation {index + 1}</Text>
                        <Text style={styles.delegationStatus}>{formatStatus(message.tool.state)}</Text>
                    </View>
                    <DelegateView
                        tool={message.tool}
                        messages={message.children}
                        metadata={session.metadata}
                    />
                </View>
            ))}

            {delegations.roots.length === 0 && (
                <View style={styles.emptyState}>
                    <Ionicons name="git-network-outline" size={40} color={theme.colors.textSecondary} />
                    <Text style={styles.emptyTitle}>No subagent activity</Text>
                    <Text style={styles.emptyText}>
                        Subagents delegated during this session will appear here with their status, output, and tool activity.
                    </Text>
                </View>
            )}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
    },
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 40,
        gap: 14,
    },
    summary: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    summaryIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    summaryText: {
        flex: 1,
        gap: 2,
    },
    summaryTitle: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '600',
    },
    summarySubtitle: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    delegationCard: {
        overflow: 'hidden',
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingTop: 12,
    },
    delegationHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingBottom: 10,
    },
    delegationTitle: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    delegationStatus: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    emptyState: {
        alignItems: 'center',
        paddingHorizontal: 24,
        paddingVertical: 56,
        gap: 10,
    },
    emptyTitle: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '600',
    },
    emptyText: {
        maxWidth: 360,
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        textAlign: 'center',
    },
}));
