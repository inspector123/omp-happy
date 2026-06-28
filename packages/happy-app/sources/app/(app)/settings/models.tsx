import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { getAvailableModels } from '@/components/modelModeOptions';
import { useSession, useSettingMutable } from '@/sync/storage';
import { t } from '@/text';

/**
 * Model shortlist curation page.
 *
 * omp can advertise 40+ models, which overflows the composer's settings
 * overlay. This page lists every model the current session offers and lets the
 * user tick the few they actually use; the composer picker then shows only the
 * ticked ones (see AgentInput — `modelShortlist`). Empty shortlist = show all.
 *
 * The session's model list lives in its metadata, so we read it via the
 * `sessionId` passed as a route param.
 */
export default function ModelShortlistScreen() {
    const { theme } = useUnistyles();
    const { sessionId } = useLocalSearchParams<{ sessionId?: string }>();
    const session = useSession(sessionId ?? '');
    const [shortlist, setShortlist] = useSettingMutable('modelShortlist');

    const models = React.useMemo(() => {
        const metadata = session?.metadata ?? null;
        return getAvailableModels(metadata?.flavor, metadata, t);
    }, [session?.metadata]);

    const enabled = React.useMemo(() => new Set(shortlist), [shortlist]);

    const toggle = React.useCallback((key: string) => {
        setShortlist(
            enabled.has(key)
                ? shortlist.filter((k) => k !== key)
                : [...shortlist, key],
        );
    }, [enabled, shortlist, setShortlist]);

    const clearAll = React.useCallback(() => {
        // Remove only this session's model keys, leaving other agents' picks intact.
        const here = new Set(models.map((m) => m.key));
        setShortlist(shortlist.filter((k) => !here.has(k)));
    }, [models, shortlist, setShortlist]);

    if (models.length === 0) {
        return (
            <ItemList>
                <ItemGroup footer="This session doesn't advertise a model list.">
                    <Item title="No models available" />
                </ItemGroup>
            </ItemList>
        );
    }

    const selectedHere = models.filter((m) => enabled.has(m.key)).length;

    return (
        <ItemList>
            <ItemGroup
                title="Shown in the picker"
                footer={
                    selectedHere > 0
                        ? `${selectedHere} selected. The composer will show only these. Tap to toggle.`
                        : 'Nothing selected — the composer shows all models. Tick the ones you use.'
                }
            >
                {models.map((model) => {
                    const isOn = enabled.has(model.key);
                    return (
                        <Item
                            key={model.key}
                            title={model.name}
                            subtitle={model.key !== model.name ? model.key : undefined}
                            selected={isOn}
                            onPress={() => toggle(model.key)}
                            rightElement={
                                isOn ? (
                                    <Ionicons name="checkmark" size={22} color={theme.colors.radio.active} />
                                ) : (
                                    <Ionicons name="ellipse-outline" size={22} color={theme.colors.radio.inactive} />
                                )
                            }
                        />
                    );
                })}
            </ItemGroup>
            {selectedHere > 0 && (
                <ItemGroup>
                    <Item
                        title="Show all models"
                        detail="Clear this session's selection"
                        destructive
                        onPress={clearAll}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
