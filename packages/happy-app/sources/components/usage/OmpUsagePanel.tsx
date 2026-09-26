import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import {
    fetchMachineOmpUsage,
    type OmpUsageCapacityWindow,
    type OmpUsageRange,
    type OmpUsageReport,
    type OmpUsageSnapshot,
    type OmpTokenDayPoint,
    type OmpTokenModelRow,
    type OmpUsageLimit,
} from '@/sync/apiOmpUsage';
import {
    collapseSharedLimits,
    formatAgo,
    formatCompactNumber,
    formatCountdown,
    formatCost,
    formatDayLabel,
    formatRemainingAmount,
    formatUsedAmount,
    groupReportsByProvider,
    limitTitle,
    providerDisplayName,
    resolveUsedFraction,
    usageSeverity,
    type UsageSeverity,
} from './ompUsageFormat';

/** How long a background provider fetch / session resync is polled for. */
const BACKGROUND_POLL_MS = 5_000;
const BACKGROUND_POLL_LIMIT = 24;
/** A machine whose daemon predates the usage RPC answers with this shape. */
const UNSUPPORTED_RPC = /method not available|unknown method|not supported|no handler/i;

const RANGE_TABS: { key: OmpUsageRange; label: () => string }[] = [
    { key: 'today', label: () => t('usage.today') },
    { key: '7d', label: () => t('usage.last7Days') },
    { key: '30d', label: () => t('usage.last30Days') },
];

const styles = StyleSheet.create((theme) => ({
    content: {
        paddingBottom: 24,
    },
    switcherRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginTop: 16,
        paddingLeft: 16,
    },
    switcherLabel: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.groupped.sectionTitle,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    switcherScroll: {
        flex: 1,
    },
    switcherContent: {
        gap: 8,
        paddingRight: 16,
    },
    machinePill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    machinePillActive: {
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.colors.textLink,
    },
    machinePillText: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    machinePillTextActive: {
        color: theme.colors.textLink,
    },
    scopeText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 8,
        paddingHorizontal: 16,
    },
    actionStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    rangeRow: {
        flexDirection: 'row',
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    rangeTab: {
        flex: 1,
        paddingVertical: 10,
        alignItems: 'center',
    },
    rangeTabActive: {
        backgroundColor: theme.colors.button?.primary?.background ?? '#007AFF',
    },
    rangeLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    rangeLabelActive: {
        color: '#FFFFFF',
    },
    actionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 8,
        gap: 12,
    },
    actionText: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    actionButtonText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
    },
    accountBlock: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    accountTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    accountMeta: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    limitBlock: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 12,
    },
    limitHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
    },
    limitTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
        flexShrink: 1,
    },
    limitAmount: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.divider,
        marginTop: 6,
        overflow: 'hidden',
    },
    barFill: {
        height: '100%',
        borderRadius: 3,
    },
    limitFoot: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    statRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 16,
    },
    statCell: {
        minWidth: 96,
    },
    statLabel: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    statValue: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text,
        marginTop: 2,
    },
    modelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 12,
    },
    modelName: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text,
        flexShrink: 1,
    },
    modelProvider: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    modelFigures: {
        alignItems: 'flex-end',
    },
    modelTokens: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
    },
    modelCost: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    chartRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 4,
        height: 132,
        gap: 4,
    },
    chartColumn: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'flex-end',
        height: '100%',
    },
    chartBar: {
        width: '100%',
        borderRadius: 3,
        minHeight: 2,
    },
    chartLabel: {
        ...Typography.default(),
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginTop: 6,
    },
    chartValue: {
        ...Typography.default(),
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    noteBlock: {
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    noteText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));

interface SeverityColors {
    ok: string;
    warning: string;
    critical: string;
    unknown: string;
}

function severityColor(severity: UsageSeverity, colors: SeverityColors): string {
    if (severity === 'critical') return colors.critical;
    if (severity === 'warning') return colors.warning;
    if (severity === 'ok') return colors.ok;
    return colors.unknown;
}

const LimitRow: React.FC<{ limit: OmpUsageLimit }> = ({ limit }) => {
    const { theme } = useUnistyles();
    const fraction = resolveUsedFraction(limit);
    const severity = usageSeverity(fraction);
    const usedText = formatUsedAmount(limit);
    const remainingText = formatRemainingAmount(limit);
    const resetIn = limit.resetsAt && limit.resetsAt > Date.now()
        ? t('usage.resetsIn', { time: formatCountdown(limit.resetsAt - Date.now()) })
        : undefined;

    return (
        <View style={styles.limitBlock}>
            <View style={styles.limitHeader}>
                <Text style={styles.limitTitle} numberOfLines={2}>{limitTitle(limit)}</Text>
                <Text style={styles.limitAmount}>
                    {usedText
                        ? remainingText
                            ? `${t('usage.usedLabel', { value: usedText })} · ${t('usage.leftLabel', { value: remainingText })}`
                            : t('usage.usedLabel', { value: usedText })
                        : '—'}
                </Text>
            </View>
            <View style={styles.barTrack}>
                <View
                    style={[
                        styles.barFill,
                        {
                            width: `${Math.min(100, Math.max(0, (fraction ?? 0) * 100))}%`,
                            backgroundColor: severityColor(severity, {
                                ok: theme.colors.success,
                                warning: '#FF9500',
                                critical: theme.colors.warningCritical,
                                unknown: theme.colors.textSecondary,
                            }),
                        },
                    ]}
                />
            </View>
            {resetIn ? <Text style={styles.limitFoot}>{resetIn}</Text> : null}
            {limit.notes?.map((note) => (
                <Text key={note} style={styles.limitFoot}>{note}</Text>
            ))}
        </View>
    );
};

const AccountBlock: React.FC<{ report: OmpUsageReport; capacity?: OmpUsageCapacityWindow[] }> = ({ report, capacity }) => {
    const limits = useMemo(() => collapseSharedLimits(report.limits), [report.limits]);
    const credits = report.resetCredits;
    const sharedWindow = capacity?.find((window) => window.accounts > 1);
    const bankedExpiry = credits?.soonestExpiry
        ? Date.parse(credits.soonestExpiry) - Date.now()
        : undefined;

    return (
        <View>
            <View style={styles.accountBlock}>
                <Text style={styles.accountTitle}>{report.account.label}</Text>
                <Text style={styles.accountMeta}>
                    {[
                        report.account.planType,
                        sharedWindow
                            ? t('usage.acrossAccounts', {
                                accounts: sharedWindow.accounts,
                                percent: `${(sharedWindow.usedAccounts * 100).toFixed(0)}%`,
                            })
                            : undefined,
                    ].filter(Boolean).join(' · ')}
                </Text>
                {credits && credits.availableCount > 0 ? (
                    <Text style={styles.limitFoot}>
                        {t('usage.bankedResets', { count: credits.availableCount })}
                        {bankedExpiry && bankedExpiry > 0 ? ` — ${t('usage.bankedResetsExpiring', { time: formatCountdown(bankedExpiry) })}` : ''}
                    </Text>
                ) : null}
                {report.notes?.map((note) => (
                    <Text key={note} style={styles.limitFoot}>{note}</Text>
                ))}
            </View>
            {limits.map((limit) => (
                <LimitRow key={limit.id} limit={limit} />
            ))}
        </View>
    );
};

const DailyChart: React.FC<{ days: OmpTokenDayPoint[]; now: number }> = ({ days, now }) => {
    const { theme } = useUnistyles();
    const maxTokens = Math.max(1, ...days.map((day) => day.tokens));
    const visible = days.slice(-14);

    return (
        <View style={styles.chartRow}>
            {visible.map((day) => {
                const height = Math.max(2, Math.round((day.tokens / maxTokens) * 96));
                return (
                    <View key={day.timestamp} style={styles.chartColumn}>
                        <Text style={styles.chartValue}>{formatCompactNumber(day.tokens)}</Text>
                        <View
                            style={[
                                styles.chartBar,
                                { height, backgroundColor: theme.colors.button?.primary?.background ?? '#007AFF' },
                            ]}
                        />
                        <Text style={styles.chartLabel}>
                            {formatDayLabel(day.timestamp, now, { today: t('usage.today'), yesterday: t('usage.yesterday') })}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
};

const ModelRow: React.FC<{ row: OmpTokenModelRow }> = ({ row }) => (
    <View style={styles.modelRow}>
        <View style={{ flex: 1 }}>
            <Text style={styles.modelName} numberOfLines={1}>{row.model}</Text>
            <Text style={styles.modelProvider}>
                {`${providerDisplayName(row.provider)} · ${t('usage.requests')}: ${row.requests.toLocaleString()}`}
            </Text>
        </View>
        <View style={styles.modelFigures}>
            <Text style={styles.modelTokens}>{formatCompactNumber(row.totalTokens)}</Text>
            <Text style={styles.modelCost}>{formatCost(row.cost)}</Text>
        </View>
    </View>
);

export const OmpUsagePanel: React.FC = () => {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const [machineId, setMachineId] = useState<string | null>(null);
    const [range, setRange] = useState<OmpUsageRange>('today');
    const [snapshot, setSnapshot] = useState<OmpUsageSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pollsRef = useRef(0);
    const requestSeqRef = useRef(0);

    const selectedMachine = useMemo(
        () => machines.find((machine) => machine.id === machineId) ?? null,
        [machines, machineId],
    );

    // Default to an online machine; keep a manual choice unless it disappears.
    useEffect(() => {
        if (machines.length === 0) {
            if (machineId !== null) setMachineId(null);
            return;
        }
        if (machineId && machines.some((machine) => machine.id === machineId)) return;
        const fallback = machines.find(isMachineOnline) ?? machines[0];
        setMachineId(fallback.id);
    }, [machines, machineId]);
    const selectedOnline = selectedMachine ? isMachineOnline(selectedMachine) : false;

    const load = useCallback(async (options: { resync?: boolean } = {}) => {
        if (!machineId || !selectedOnline) return;
        const seq = ++requestSeqRef.current;
        setLoading(true);
        try {
            const result = await fetchMachineOmpUsage(machineId, { range, resync: options.resync === true });
            if (seq !== requestSeqRef.current) return;
            setSnapshot(result);
            setError(null);
        } catch (loadError) {
            if (seq !== requestSeqRef.current) return;
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            if (seq === requestSeqRef.current) setLoading(false);
        }
    }, [machineId, range, selectedOnline]);

    // A different machine or window is a different question: drop the old answer.
    useEffect(() => {
        pollsRef.current = 0;
        setSnapshot(null);
        setError(null);
    }, [machineId, range]);

    useEffect(() => {
        void load();
    }, [load]);

    // A provider fetch or session resync still running on the machine: poll a
    // bounded number of times instead of showing a stale panel forever.
    useEffect(() => {
        if (!snapshot?.refreshing && !snapshot?.syncing) {
            pollsRef.current = 0;
            return;
        }
        if (pollsRef.current >= BACKGROUND_POLL_LIMIT) return;
        pollsRef.current += 1;
        const timer = setTimeout(() => { void load(); }, BACKGROUND_POLL_MS);
        return () => clearTimeout(timer);
    }, [snapshot, load]);

    const online = selectedMachine ? isMachineOnline(selectedMachine) : false;
    const limits = snapshot?.limits ?? null;
    const tokens = snapshot?.tokens ?? null;
    const reportGroups = useMemo(() => groupReportsByProvider(limits?.reports ?? []), [limits]);
    const disabledCredentials = limits?.disabledCredentials ?? [];
    const showInitialLoading = loading && !snapshot && online;

    return (
        <ItemList
            containerStyle={styles.content}
            refreshControl={(
                <RefreshControl
                    refreshing={loading}
                    onRefresh={() => { void load(); }}
                />
            )}
        >
            {machines.length === 0 ? (
                <ItemGroup title={t('usage.machine')}>
                    <Item
                        title={t('usage.noData')}
                        subtitle={t('usage.machineOffline')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : (
                <>
                    <View style={styles.switcherRow}>
                        <Text style={styles.switcherLabel}>{t('usage.machine')}</Text>
                        <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator={false}
                            style={styles.switcherScroll}
                            contentContainerStyle={styles.switcherContent}
                        >
                            {machines.map((machine) => {
                                const active = machine.id === machineId;
                                return (
                                    <Pressable
                                        key={machine.id}
                                        style={[styles.machinePill, active && styles.machinePillActive]}
                                        onPress={() => setMachineId(machine.id)}
                                    >
                                        <Ionicons
                                            name="ellipse"
                                            size={8}
                                            color={isMachineOnline(machine) ? theme.colors.success : theme.colors.textSecondary}
                                        />
                                        <Text style={[styles.machinePillText, active && styles.machinePillTextActive]}>
                                            {machine.metadata?.displayName || machine.metadata?.host || machine.id}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </ScrollView>
                    </View>
                    {selectedMachine ? (
                        <Text style={styles.scopeText}>
                            {t('usage.viewing', {
                                machine: selectedMachine.metadata?.displayName
                                    || selectedMachine.metadata?.host
                                    || selectedMachine.id,
                            })}
                        </Text>
                    ) : null}
                </>
            )}

            <View style={styles.rangeRow}>
                {RANGE_TABS.map((tab) => (
                    <Pressable
                        key={tab.key}
                        style={[styles.rangeTab, range === tab.key && styles.rangeTabActive]}
                        onPress={() => setRange(tab.key)}
                    >
                        <Text style={[styles.rangeLabel, range === tab.key && styles.rangeLabelActive]}>
                            {tab.label()}
                        </Text>
                    </Pressable>
                ))}
            </View>

            <View style={styles.actionRow}>
                <View style={styles.actionStatus}>
                    {showInitialLoading ? <ActivityIndicator size="small" /> : null}
                    <Text style={styles.actionText}>
                        {showInitialLoading
                            ? t('usage.refreshingLabel')
                            : snapshot?.generatedAt
                                ? t('usage.updatedAgo', { time: formatAgo(Math.max(0, Date.now() - snapshot.generatedAt)) })
                                : ''}
                    </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable style={styles.actionButton} onPress={() => { void load({ resync: true }); }} disabled={loading}>
                        <Ionicons name="sync-outline" size={14} color={snapshot?.syncing ? '#007AFF' : undefined} />
                        <Text style={styles.actionButtonText}>{t('usage.resync')}</Text>
                    </Pressable>
                    <Pressable style={styles.actionButton} onPress={() => { void load(); }} disabled={loading}>
                        <Ionicons name="refresh" size={14} />
                        <Text style={styles.actionButtonText}>{t('usage.refresh')}</Text>
                    </Pressable>
                </View>
            </View>

            {!online && machines.length > 0 ? (
                <ItemGroup title={t('usage.providerQuotas')}>
                    <Item title={t('usage.machineOffline')} showChevron={false} />
                </ItemGroup>
            ) : null}

            {error ? (
                <ItemGroup title={t('usage.problems')}>
                    <View style={styles.noteBlock}>
                        <Text style={styles.noteText}>
                            {UNSUPPORTED_RPC.test(error) ? t('usage.rpcUnavailable') : t('usage.loadFailed', { message: error })}
                        </Text>
                    </View>
                </ItemGroup>
            ) : null}

            {snapshot && !error ? (
                <>
                    <ItemGroup title={t('usage.providerQuotas')}>
                        {snapshot.refreshing ? (
                            <View style={styles.noteBlock}>
                                <Text style={styles.noteText}>{t('usage.refreshingLabel')}</Text>
                            </View>
                        ) : null}
                        {reportGroups.length === 0 && !snapshot.refreshing ? (
                            <Item title={t('usage.noQuotas')} showChevron={false} />
                        ) : null}
                        {reportGroups.map((group) => (
                            <View key={group.provider}>
                                <View style={styles.accountBlock}>
                                    <Text style={styles.accountTitle}>{providerDisplayName(group.provider)}</Text>
                                </View>
                                {group.reports.map((report) => (
                                    <AccountBlock
                                        key={`${report.provider}:${report.account.label}`}
                                        report={report}
                                        capacity={limits?.capacity[report.provider]}
                                    />
                                ))}
                            </View>
                        ))}
                        {disabledCredentials.length > 0 ? (
                            <View style={styles.noteBlock}>
                                <Text style={styles.noteText}>
                                    {t('usage.disabledCredentials', { count: disabledCredentials.length })}
                                </Text>
                                {disabledCredentials.map((credential) => (
                                    <Text key={`${credential.provider}:${credential.cause}`} style={styles.noteText}>
                                        {`${providerDisplayName(credential.provider)}: ${credential.cause}`}
                                    </Text>
                                ))}
                            </View>
                        ) : null}
                    </ItemGroup>

                    <ItemGroup title={`${t('usage.tokens')} / ${t('usage.cost')}`}>
                        {snapshot.syncing ? (
                            <View style={styles.noteBlock}>
                                <Text style={styles.noteText}>{t('usage.syncingLabel')}</Text>
                            </View>
                        ) : null}
                        {tokens ? (
                            <>
                                <View style={styles.statRow}>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.totalTokens')}</Text>
                                        <Text style={styles.statValue}>{formatCompactNumber(tokens.totals.totalTokens)}</Text>
                                    </View>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.totalCost')}</Text>
                                        <Text style={styles.statValue}>{formatCost(tokens.totals.cost)}</Text>
                                    </View>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.requests')}</Text>
                                        <Text style={styles.statValue}>{formatCompactNumber(tokens.totals.requests)}</Text>
                                    </View>
                                    {tokens.totals.avgTokensPerSecond ? (
                                        <View style={styles.statCell}>
                                            <Text style={styles.statLabel}>{t('usage.speed')}</Text>
                                            <Text style={styles.statValue}>
                                                {t('usage.avgSpeed', { value: tokens.totals.avgTokensPerSecond.toFixed(1) })}
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>
                                <View style={styles.statRow}>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.input')}</Text>
                                        <Text style={styles.statValue}>{formatCompactNumber(tokens.totals.inputTokens)}</Text>
                                    </View>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.output')}</Text>
                                        <Text style={styles.statValue}>{formatCompactNumber(tokens.totals.outputTokens)}</Text>
                                    </View>
                                    <View style={styles.statCell}>
                                        <Text style={styles.statLabel}>{t('usage.cacheRead')}</Text>
                                        <Text style={styles.statValue}>{formatCompactNumber(tokens.totals.cacheReadTokens)}</Text>
                                    </View>
                                </View>
                            </>
                        ) : (
                            <Item title={t('usage.noData')} showChevron={false} />
                        )}
                    </ItemGroup>

                    {tokens && tokens.daily.length > 0 ? (
                        <ItemGroup title={t('usage.daily')}>
                            <DailyChart days={tokens.daily} now={snapshot.generatedAt} />
                        </ItemGroup>
                    ) : null}

                    {tokens && tokens.byModel.length > 0 ? (
                        <ItemGroup title={t('usage.byModel')}>
                            {tokens.byModel.map((row) => (
                                <ModelRow key={`${row.provider}:${row.model}`} row={row} />
                            ))}
                        </ItemGroup>
                    ) : null}

                    {snapshot.errors.length > 0 ? (
                        <ItemGroup title={t('usage.problems')}>
                            {snapshot.errors.map((problem) => (
                                <View key={problem} style={styles.noteBlock}>
                                    <Text style={styles.noteText}>{problem}</Text>
                                </View>
                            ))}
                        </ItemGroup>
                    ) : null}
                </>
            ) : null}
        </ItemList>
    );
};
