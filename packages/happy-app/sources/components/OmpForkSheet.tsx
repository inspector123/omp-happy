import * as React from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { useHappyAction } from '@/hooks/useHappyAction';
import { forkAndSpawn } from '@/sync/ops';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import { getSessionForkSource } from '@/utils/sessionFork';

export interface OmpForkSheetProps {
    sessionId: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

const SEARCH_THRESHOLD = 6;

/**
 * Forks an OMP chat into a new chat that starts with a chosen model. OMP copies
 * the conversation into a new session (`omp --fork`), so the new chat continues
 * from here while this chat stays exactly as it is for when the user comes back.
 */
export const OmpForkSheet = React.memo(function OmpForkSheet(props: OmpForkSheetProps) {
    const { sessionId, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();
    const { theme } = useUnistyles();
    const windowSize = useWindowDimensions();
    const sheetFrame = React.useMemo(
        () => getDuplicateSheetFrame(windowSize),
        [windowSize.width, windowSize.height],
    );

    const source = session ? getSessionForkSource(session) : null;
    const models = session?.metadata?.models ?? [];
    const currentModel = session?.metadata?.currentModelCode;
    const [selectedCode, setSelectedCode] = React.useState<string | null>(currentModel ?? models[0]?.code ?? null);
    const [query, setQuery] = React.useState('');
    const normalizedQuery = query.trim().toLowerCase();
    const shownModels = normalizedQuery
        ? models.filter((model) => `${model.value} ${model.code}`.toLowerCase().includes(normalizedQuery))
        : models;
    const selectedModel = models.find((model) => model.code === selectedCode);

    const [forking, doFork] = useHappyAction(async () => {
        if (!source || source.kind !== 'omp') {
            Modal.alert(t('common.error'), t('session.forkErrorMissingMetadata'));
            return;
        }
        const result = await forkAndSpawn(source, { ompModel: selectedCode ?? undefined });
        if (result.type === 'success') {
            onClose?.();
            // Push, not replace: going back from the fork returns to this chat.
            router.push(`/session/${encodeURIComponent(result.sessionId)}`);
            return;
        }
        Modal.alert(t('common.error'), result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'));
    });

    return (
        <View style={[styles.sheet, sheetFrame]}>
            <View style={styles.header}>
                <Text style={styles.title}>Fork into a new chat</Text>
                <Text style={styles.subtitle}>
                    The new chat starts with this conversation and the model you pick. This chat stays as it is, so you can come back to it after the fork.
                </Text>
                {session?.thinking === true && (
                    <Text style={styles.warning}>
                        The agent is still working. The fork copies the conversation as saved so far.
                    </Text>
                )}
            </View>

            {models.length > SEARCH_THRESHOLD && (
                <View style={styles.searchRow}>
                    <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search models"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.searchInput}
                    />
                </View>
            )}

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                {models.length === 0 ? (
                    <Text style={styles.emptyText}>
                        This chat has not reported its models yet. The fork keeps the current model.
                    </Text>
                ) : shownModels.length === 0 ? (
                    <Text style={styles.emptyText}>No models match "{query.trim()}".</Text>
                ) : (
                    shownModels.map((model) => {
                        const isSelected = model.code === selectedCode;
                        return (
                            <Pressable
                                key={model.code}
                                onPress={() => setSelectedCode(model.code)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isSelected }}
                                style={({ pressed }) => [
                                    styles.row,
                                    isSelected && styles.rowSelected,
                                    pressed && styles.rowPressed,
                                ]}
                            >
                                <View style={styles.rowTextColumn}>
                                    <Text style={styles.rowTitle} numberOfLines={1}>
                                        {model.value}{model.code === currentModel ? ' (current)' : ''}
                                    </Text>
                                    <Text style={styles.rowMeta} numberOfLines={1}>{model.code}</Text>
                                </View>
                                {isSelected && <Ionicons name="checkmark" size={20} color={theme.colors.text} />}
                            </Pressable>
                        );
                    })
                )}
            </ScrollView>

            <View style={styles.actions}>
                <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={doFork}
                    disabled={forking || !source}
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        (forking || !source) && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.buttonPrimaryText} numberOfLines={1}>
                        {forking ? t('common.loading') : selectedModel ? `Fork with ${selectedModel.value}` : 'Fork'}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    warning: {
        marginTop: 8,
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.warning,
    },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    searchInput: {
        flex: 1,
        paddingVertical: Platform.select({ ios: 9, default: 7 }),
        fontSize: 15,
        color: theme.colors.text,
    },
    list: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: 420,
        minHeight: 0,
    },
    listContent: {
        paddingVertical: 8,
    },
    emptyText: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        paddingVertical: 32,
        paddingHorizontal: 20,
        fontSize: 14,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowTextColumn: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 15,
        color: theme.colors.text,
    },
    rowMeta: {
        marginTop: 2,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        padding: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: Platform.select({ ios: 11, default: 12 }),
        paddingHorizontal: 12,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    buttonPrimaryText: {
        color: theme.colors.button.primary.tint,
        fontSize: 15,
        fontWeight: '600' as const,
    },
    buttonSecondaryText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '500' as const,
    },
}));
