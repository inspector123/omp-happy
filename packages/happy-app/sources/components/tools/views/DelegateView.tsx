import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_all';
import { CodeView } from '@/components/CodeView';

/**
 * DelegateView — renderer for omp's `delegate_task` subagent tool.
 *
 * omp's multi-agent runs are encapsulated inside a SINGLE tool call (unlike
 * Claude, whose subagents are separate linked sub-sessions). The assignment
 * lives in `tool.input.tasks[]`; live + final per-agent state lives in the
 * tool's structured output (`tool.result.details.progress[]` while running,
 * `…results[]` on completion). We merge all three by task id and render one
 * row per agent — mirroring the omp-android DelegateBody.
 */

type AgentRow = {
    id: string;
    description?: string;
    role?: string;
    status?: string;
    toolCount?: number;
    tokens?: number;
    cost?: number;
    durationMs?: number;
    output?: string;
};

function asArray(v: unknown): any[] {
    return Array.isArray(v) ? v : [];
}

function getDetails(result: unknown): { progress: any[]; results: any[] } {
    if (result && typeof result === 'object') {
        const details = (result as any).details;
        if (details && typeof details === 'object') {
            return { progress: asArray(details.progress), results: asArray(details.results) };
        }
    }
    return { progress: [], results: [] };
}

function mergeAgents(input: unknown, result: unknown): AgentRow[] {
    const byId = new Map<string, AgentRow>();
    const upsert = (id: string, patch: Partial<AgentRow>) => {
        const prev = byId.get(id) ?? { id };
        byId.set(id, { ...prev, ...patch });
    };

    // 1) Base from the assignment (input.tasks[])
    const tasks = asArray((input as any)?.tasks);
    for (const task of tasks) {
        if (!task?.id) continue;
        upsert(String(task.id), { description: task.description, role: task.role });
    }

    // 2) Live progress
    const { progress, results } = getDetails(result);
    for (const p of progress) {
        if (!p?.id) continue;
        upsert(String(p.id), {
            description: p.description,
            status: p.status,
            toolCount: p.toolCount,
            tokens: p.tokens,
            cost: p.cost,
        });
    }

    // 3) Final results win
    for (const r of results) {
        if (!r?.id) continue;
        upsert(String(r.id), {
            status: r.aborted ? 'aborted' : (r.exitCode === 0 ? 'completed' : (r.status ?? 'completed')),
            durationMs: r.durationMs,
            tokens: r.tokens ?? undefined,
            output: typeof r.output === 'string' ? r.output : undefined,
        });
    }

    return Array.from(byId.values());
}

function statusColor(status?: string): string {
    switch (status) {
        case 'completed': return '#3FB950';
        case 'running': return '#D29922';
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

export const DelegateView = React.memo<ToolViewProps>(({ tool }) => {
    const agents = React.useMemo(
        () => mergeAgents(tool.input, tool.result),
        [tool.input, tool.result],
    );

    if (agents.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            <Text style={styles.header}>{agents.length} agent{agents.length === 1 ? '' : 's'}</Text>
            {agents.map((a) => {
                const metrics = metricsLine(a);
                return (
                    <View key={a.id} style={styles.agentRow}>
                        <View style={styles.agentHeader}>
                            <View style={[styles.statusDot, { backgroundColor: statusColor(a.status) }]} />
                            <Text style={styles.agentId}>{a.id}</Text>
                            {a.status && <Text style={styles.statusText}>{a.status}</Text>}
                        </View>
                        {!!a.description && <Text style={styles.description}>{a.description}</Text>}
                        {!!a.role && <Text style={styles.role}>{a.role}</Text>}
                        {!!metrics && <Text style={styles.metrics}>{metrics}</Text>}
                        {!!a.output && (
                            <ToolSectionView fullWidth>
                                <CodeView code={a.output.length > 2000 ? a.output.slice(0, 2000) + '…' : a.output} />
                            </ToolSectionView>
                        )}
                    </View>
                );
            })}
        </View>
    );
});

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
}));
