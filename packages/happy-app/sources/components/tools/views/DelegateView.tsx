import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { CodeView } from '@/components/CodeView';
import { Message, ToolCall } from '@/sync/typesMessage';

/**
 * DelegateView — renderer for omp's `delegate_task` subagent tool.
 *
 * Renders one row per assigned task with:
 * - Status dot + id + description + role + metrics + output (merged from input/progress/results)
 * - Collapsible child timeline grouped by exact `message.subagentId === task.sessionSubagent`
 * - Distinct rendering for text / thinking / tool-call children
 * - Recursive rendering for nested `delegate_task` tool children
 * - Unknown child IDs rendered in an explicit "unassigned" group
 *
 * Assignment-only rows default to `running` while the parent tool is running,
 * but explicit progress/results override.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type AgentRow = {
    id: string;
    sessionSubagent?: string;
    description?: string;
    role?: string;
    status?: string;
    toolCount?: number;
    tokens?: number;
    cost?: number;
    durationMs?: number;
    output?: string;
};

type ChildItem = {
    id: string;
    type: 'text' | 'thinking' | 'tool';
    text?: string;
    toolName?: string;
    toolState?: 'running' | 'completed' | 'error';
    toolInputPreview?: string;
    toolResultPreview?: string;
    tool?: ToolCall;
    childMessages?: Message[];
    createdAt: number;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */


type DetailsProgress = Record<string, unknown>;
type DetailsResults = Record<string, unknown>;

function getDetails(result: unknown): { progress: DetailsProgress[]; results: DetailsResults[] } {
    if (result && typeof result === 'object' && 'details' in result) {
        const details = (result as Record<string, unknown>).details;
        if (details && typeof details === 'object') {
            const d = details as Record<string, unknown>;
            return {
                progress: Array.isArray(d.progress) ? d.progress as DetailsProgress[] : [],
                results: Array.isArray(d.results) ? d.results as DetailsResults[] : [],
            };
        }
    }
    return { progress: [], results: [] };
}

function extractTasks(input: unknown): Record<string, unknown>[] {
    if (!input || typeof input !== 'object' || !('tasks' in input)) return [];
    const tasks = (input as Record<string, unknown>).tasks;
    return Array.isArray(tasks) ? tasks as Record<string, unknown>[] : [];
}

/** Normalize OMP progress/result/lifecycle spellings for display. */
function normalizeStatus(status: unknown): string | undefined {
    if (typeof status !== 'string') return undefined;
    switch (status.toLowerCase()) {
        case 'success':
        case 'succeeded':
        case 'done':
            return 'completed';
        case 'error':
            return 'failed';
        case 'cancelled':
        case 'canceled':
            return 'aborted';
        default:
            return status.toLowerCase();
    }
}

function latestLifecycleStatus(messages: Message[]): string | undefined {
    let status: string | undefined;
    for (const message of messages) {
        if (message.kind !== 'agent-event' || message.event.type !== 'subagent-lifecycle') continue;
        status = normalizeStatus(message.event.status);
    }
    return status;
}

function mergeAgents(
    input: unknown,
    result: unknown,
    parentState: ToolCall['state'],
    childMessages: Map<string, Message[]>,
): AgentRow[] {
    const tasks = extractTasks(input);
    const rows: AgentRow[] = tasks.map((task, index) => ({
        id: typeof task.id === 'string' && task.id.length > 0 ? task.id : `task-${index + 1}`,
        description: typeof task.description === 'string' ? task.description : undefined,
        role: typeof task.role === 'string'
            ? task.role
            : typeof task.agent === 'string'
                ? task.agent
                : undefined,
        sessionSubagent: typeof task.sessionSubagent === 'string' ? task.sessionSubagent : undefined,
        status: parentState === 'running' ? 'running' : parentState === 'error' ? 'failed' : undefined,
    }));
    const rowById = new Map(rows.map((row, index) => [row.id, index]));

    const upsert = (source: Record<string, unknown>, patch: Partial<AgentRow>) => {
        const sourceIndex = typeof source.index === 'number' && Number.isInteger(source.index)
            ? source.index
            : undefined;
        const sourceId = typeof source.id === 'string' ? source.id : undefined;
        let rowIndex = sourceIndex !== undefined && sourceIndex >= 0 && sourceIndex < rows.length
            ? sourceIndex
            : sourceId !== undefined
                ? rowById.get(sourceId)
                : undefined;

        if (rowIndex === undefined) {
            rowIndex = rows.length;
            const id = sourceId ?? `task-${rowIndex + 1}`;
            rows.push({ id });
            rowById.set(id, rowIndex);
        }

        const definedPatch = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
        ) as Partial<AgentRow>;
        const previousId = rows[rowIndex].id;
        rows[rowIndex] = { ...rows[rowIndex], ...definedPatch };
        if (definedPatch.id && definedPatch.id !== previousId) {
            rowById.delete(previousId);
            rowById.set(definedPatch.id, rowIndex);
        }
    };

    const { progress, results } = getDetails(result);
    for (const item of progress) {
        upsert(item, {
            id: typeof item.id === 'string' ? item.id : undefined,
            description: typeof item.description === 'string' ? item.description : undefined,
            status: normalizeStatus(item.status),
            toolCount: typeof item.toolCount === 'number' ? item.toolCount : undefined,
            tokens: typeof item.tokens === 'number' ? item.tokens : undefined,
            cost: typeof item.cost === 'number' ? item.cost : undefined,
        });
    }

    for (const item of results) {
        const itemStatus = item.aborted
            ? 'aborted'
            : normalizeStatus(item.status)
                ?? (typeof item.exitCode === 'number' ? (item.exitCode === 0 ? 'completed' : 'failed') : 'completed');
        upsert(item, {
            id: typeof item.id === 'string' ? item.id : undefined,
            status: itemStatus,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
            tokens: typeof item.tokens === 'number' ? item.tokens : undefined,
            output: typeof item.output === 'string' ? item.output : undefined,
        });
    }

    for (const row of rows) {
        if (!row.sessionSubagent) continue;
        const lifecycleStatus = latestLifecycleStatus(childMessages.get(row.sessionSubagent) ?? []);
        if (lifecycleStatus) row.status = lifecycleStatus;
    }

    return rows;
}

/** Group messages by exact protocol subagent id. */
function groupChildMessages(messages: Message[]): { assigned: Map<string, Message[]>; unassigned: Message[] } {
    const assigned = new Map<string, Message[]>();
    const unassigned: Message[] = [];

    for (const message of messages) {
        if (!message.subagentId) {
            unassigned.push(message);
            continue;
        }
        const bucket = assigned.get(message.subagentId) ?? [];
        bucket.push(message);
        assigned.set(message.subagentId, bucket);
    }

    return { assigned, unassigned };
}


/** Flatten messages into child timeline items (text / thinking / tool) */
function extractChildItems(messages: Message[]): ChildItem[] {
    const items: ChildItem[] = [];

    for (const message of messages) {
        if (message.kind === 'agent-text' || message.kind === 'user-text') {
            items.push({
                id: message.id,
                type: message.kind === 'agent-text' && message.isThinking ? 'thinking' : 'text',
                text: message.text,
                createdAt: message.createdAt,
            });
            continue;
        }

        if (message.kind !== 'tool-call') continue;
        items.push({
            id: message.id,
            type: 'tool',
            toolName: message.tool.name,
            toolState: message.tool.state,
            toolInputPreview: previewTruncated(message.tool.input, 120),
            toolResultPreview: message.tool.result !== undefined
                ? previewTruncated(message.tool.result, 120)
                : undefined,
            tool: message.tool,
            childMessages: message.children,
            createdAt: message.createdAt,
        });
    }

    return items;
}

function previewTruncated(value: unknown, maxLen: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    try {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s;
    } catch {
        return undefined;
    }
}

function statusColor(status?: string): string {
    switch (status) {
        case 'completed': return '#3FB950';
        case 'running':
        case 'pending':
        case 'queued':
            return '#D29922';
        case 'failed': return '#F85149';
        case 'aborted': return '#8B949E';
        default: return '#8B949E';
    }
}

function metricsLine(a: AgentRow): string | null {
    const parts: string[] = [];
    if (typeof a.toolCount === 'number') parts.push(`${a.toolCount} tools`);
    if (typeof a.tokens === 'number') parts.push(`${a.tokens.toLocaleString()} tok`);
    if (typeof a.cost === 'number') parts.push(`$${a.cost.toFixed(3)}`);
    if (typeof a.durationMs === 'number') parts.push(`${(a.durationMs / 1000).toFixed(1)}s`);
    return parts.length ? parts.join(' · ') : null;
}

/* ------------------------------------------------------------------ */
/*  ChildTimelineItem — single child entry in the timeline             */
/* ------------------------------------------------------------------ */

const ChildTimelineItem = React.memo<{
    item: ChildItem;
    depth: number;
    metadata: ToolViewProps['metadata'];
}>(({ item, depth, metadata }) => {
    const { theme } = useUnistyles();

    if (item.type === 'text') {
        const text = item.text ?? '';
        const display = text.length > 300 ? `${text.slice(0, 300)}…` : text;
        return (
            <View style={[styles.childItem, { marginLeft: depth * 12 }]}>
                <Ionicons name="chatbubble-ellipses-outline" size={12} color={theme.colors.textSecondary} />
                <Text style={styles.childText} numberOfLines={8}>{display}</Text>
            </View>
        );
    }

    if (item.type === 'thinking') {
        const text = item.text ?? '';
        const display = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return (
            <View style={[styles.childItem, styles.childItemThinking, { marginLeft: depth * 12 }]}>
                <Ionicons name="bulb-outline" size={12} color={theme.colors.textSecondary} />
                <View style={styles.childTextColumn}>
                    <Text style={styles.childReasoningLabel}>Reasoning</Text>
                    <Text style={styles.childThinkingText} numberOfLines={5}>{display}</Text>
                </View>
            </View>
        );
    }

    return <ChildToolItem item={item} depth={depth} metadata={metadata} />;
});

/* ------------------------------------------------------------------ */
/*  ChildToolItem — tool activity with state + input/result preview    */
/* ------------------------------------------------------------------ */

const ChildToolItem = React.memo<{
    item: ChildItem;
    depth: number;
    metadata: ToolViewProps['metadata'];
}>(({ item, depth, metadata }) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);

    if (item.tool?.name === 'delegate_task') {
        return (
            <View style={{ marginLeft: depth * 12 }}>
                <DelegateView
                    tool={item.tool}
                    metadata={metadata}
                    messages={item.childMessages ?? []}
                />
            </View>
        );
    }

    const stateIcon = item.toolState === 'running'
        ? <ActivityIndicator size={10} color={theme.colors.warning} />
        : item.toolState === 'completed'
            ? <Ionicons name="checkmark-circle" size={14} color={theme.colors.success} />
            : item.toolState === 'error'
                ? <Ionicons name="close-circle" size={14} color={theme.colors.textDestructive} />
                : null;

    return (
        <View style={[styles.childToolItem, { marginLeft: depth * 12 }]}>
            <TouchableOpacity
                onPress={() => setExpanded((value) => !value)}
                activeOpacity={0.6}
                style={styles.childToolHeader}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`${item.toolName} ${item.toolState}, ${expanded ? 'show less' : 'show more'}`}
            >
                <Ionicons name="construct-outline" size={12} color={theme.colors.textSecondary} />
                <Text style={styles.childToolName} numberOfLines={1}>{item.toolName}</Text>
                {stateIcon}
                <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
            </TouchableOpacity>

            {expanded && (
                <View style={styles.childToolDetail}>
                    {item.toolInputPreview && (
                        <ToolSectionView>
                            <CodeView code={item.toolInputPreview} />
                        </ToolSectionView>
                    )}
                    {item.toolResultPreview && (
                        <ToolSectionView>
                            <CodeView code={item.toolResultPreview} />
                        </ToolSectionView>
                    )}
                </View>
            )}
        </View>
    );
});

/* ------------------------------------------------------------------ */
/*  ChildTimeline — bounded collapsible timeline for one task          */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE_CHILD_ITEMS = 12;

const ChildTimeline = React.memo<{
    items: ChildItem[];
    label?: string;
    depth: number;
    metadata: ToolViewProps['metadata'];
    initiallyExpanded?: boolean;
}>(({ items, label, depth, metadata, initiallyExpanded = false }) => {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(initiallyExpanded);

    if (items.length === 0) return null;

    const toolCount = items.filter((item) => item.type === 'tool').length;
    const textCount = items.filter((item) => item.type === 'text').length;
    const thinkingCount = items.filter((item) => item.type === 'thinking').length;
    const parts: string[] = [];
    if (textCount) parts.push(`${textCount} message${textCount > 1 ? 's' : ''}`);
    if (thinkingCount) parts.push(`${thinkingCount} reasoning`);
    if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);

    const summary = parts.join(', ');
    const visibleItems = items.slice(-MAX_VISIBLE_CHILD_ITEMS);
    const hiddenCount = items.length - visibleItems.length;

    return (
        <View style={[styles.childTimeline, depth > 0 && { marginLeft: depth * 8 }]}>
            <TouchableOpacity
                onPress={() => setExpanded((value) => !value)}
                activeOpacity={0.6}
                style={styles.childTimelineToggle}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`${label ?? 'Activity'}: ${summary}. ${expanded ? 'Expanded, tap to collapse' : 'Collapsed, tap to expand'}`}
            >
                <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
                <Text style={styles.childTimelineLabel}>
                    {label ? `${label}: ` : ''}{summary}
                </Text>
            </TouchableOpacity>

            {expanded && (
                <View style={styles.childTimelineContent}>
                    {hiddenCount > 0 && (
                        <Text style={styles.earlierEvents}>{hiddenCount} earlier events hidden</Text>
                    )}
                    {visibleItems.map((item) => (
                        <ChildTimelineItem
                            key={item.id}
                            item={item}
                            depth={depth}
                            metadata={metadata}
                        />
                    ))}
                </View>
            )}
        </View>
    );
});

/* ------------------------------------------------------------------ */
/*  AgentRowView — one task row with optional child timeline           */
/* ------------------------------------------------------------------ */

const AgentRowView = React.memo<{
    agent: AgentRow;
    childItems: ChildItem[];
    depth: number;
    metadata: ToolViewProps['metadata'];
}>(({ agent, childItems, depth, metadata }) => {
    const { theme } = useUnistyles();
    const metrics = metricsLine(agent);

    return (
        <View style={[styles.agentRow, depth > 0 && { marginLeft: depth * 16, borderLeftColor: theme.colors.textSecondary }]}>
            <View style={styles.agentHeader}>
                <View style={[styles.statusDot, { backgroundColor: statusColor(agent.status) }]} />
                <Text style={styles.agentId}>{agent.id}</Text>
                {agent.status && <Text style={styles.statusText}>{agent.status}</Text>}
            </View>
            {!!agent.description && <Text style={styles.description}>{agent.description}</Text>}
            {!!agent.role && <Text style={styles.role}>{agent.role}</Text>}
            {!!metrics && <Text style={styles.metrics}>{metrics}</Text>}
            {!!agent.output && (
                <ToolSectionView fullWidth>
                    <CodeView code={agent.output.length > 2000 ? `${agent.output.slice(0, 2000)}…` : agent.output} />
                </ToolSectionView>
            )}
            <ChildTimeline
                items={childItems}
                depth={depth + 1}
                metadata={metadata}
                initiallyExpanded={agent.status === 'running' || agent.status === 'pending'}
            />
        </View>
    );
});

/* ------------------------------------------------------------------ */
/*  DelegateView — main component                                     */
/* ------------------------------------------------------------------ */

export const DelegateView = React.memo<ToolViewProps>(({ tool, messages, metadata }) => {
    const { assigned, unassigned } = React.useMemo(
        () => groupChildMessages(messages),
        [messages],
    );
    const agents = React.useMemo(
        () => mergeAgents(tool.input, tool.result, tool.state, assigned),
        [assigned, tool.input, tool.result, tool.state],
    );
    const unassignedItems = React.useMemo(() => extractChildItems(unassigned), [unassigned]);

    if (agents.length === 0 && unassignedItems.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {agents.length > 0 && (
                <Text style={styles.header}>{agents.length} agent{agents.length === 1 ? '' : 's'}</Text>
            )}
            {agents.map((agent) => {
                const childItems = extractChildItems(
                    agent.sessionSubagent ? assigned.get(agent.sessionSubagent) ?? [] : [],
                );
                return (
                    <AgentRowView
                        key={agent.sessionSubagent ?? agent.id}
                        agent={agent}
                        childItems={childItems}
                        depth={0}
                        metadata={metadata}
                    />
                );
            })}
            {unassignedItems.length > 0 && (
                <>
                    <Text style={styles.unassignedHeader}>Unassigned activity</Text>
                    <ChildTimeline
                        items={unassignedItems}
                        depth={0}
                        metadata={metadata}
                        initiallyExpanded={tool.state === 'running'}
                    />
                </>
            )}
        </View>
    );
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 12,
        paddingBottom: 8,
        gap: 10,
    },
    header: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    unassignedHeader: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    agentRow: {
        gap: 2,
        paddingVertical: 4,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.divider,
        paddingLeft: 8,
    },
    agentHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    agentId: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
    },
    statusText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    description: {
        fontSize: 13,
        color: theme.colors.text,
    },
    role: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    metrics: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    /* Child timeline */
    childTimeline: {
        marginTop: 4,
    },
    childTimelineToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 6,
        paddingHorizontal: 4,
    },
    childTimelineLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    childTimelineContent: {
        gap: 2,
        paddingTop: 2,
    },
    earlierEvents: {
        paddingHorizontal: 4,
        paddingVertical: 2,
        fontSize: 10,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    childItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 4,
        paddingVertical: 2,
        paddingHorizontal: 4,
    },
    childItemThinking: {
        opacity: 0.75,
    },
    childTextColumn: {
        flex: 1,
        gap: 1,
    },
    childReasoningLabel: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    childText: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text,
        lineHeight: 16,
    },
    childThinkingText: {
        flex: 1,
        fontSize: 11,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
        lineHeight: 15,
    },
    /* Child tool item */
    childToolItem: {
        paddingVertical: 2,
        paddingHorizontal: 4,
    },
    childToolHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 4,
    },
    childToolName: {
        flex: 1,
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        color: theme.colors.textSecondary,
    },
    childToolDetail: {
        marginTop: 2,
    },
}));