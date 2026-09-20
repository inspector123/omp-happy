import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { layout } from '@/components/layout';
import { Typography } from '@/constants/Typography';
import { filterPeerMessages, groupPeerMessages } from '@/sync/peerMessages';
import { useFeedItems, useSession } from '@/sync/storage';
import { formatLastSeen, getSessionName } from '@/utils/sessionUtils';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingBottom: 24,
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 16,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

export default function PeerThreadScreen() {
    const { sessionId = '' } = useLocalSearchParams<{ sessionId: string }>();
    const { theme } = useUnistyles();
    const feedItems = useFeedItems();
    const session = useSession(sessionId);
    const targetTitle = session?.metadata
        ? getSessionName(session)
        : `Session ${sessionId.slice(0, 8)}`;
    const conversation = React.useMemo(
        () => groupPeerMessages(filterPeerMessages(feedItems)).get(sessionId),
        [feedItems, sessionId],
    );
    const messages = conversation?.messages ?? [];

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: targetTitle,
                    headerBackTitle: t('peers.title'),
                }}
            />

            {messages.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>{t('peers.empty')}</Text>
                </View>
            ) : (
                <ScrollView contentContainerStyle={styles.content}>
                    <ItemGroup title={t('peers.to', { name: targetTitle })}>
                        {messages.map((message) => (
                            <Item
                                key={message.id}
                                title={message.fromTitle}
                                subtitle={message.body}
                                subtitleLines={0}
                                detail={formatLastSeen(message.ts)}
                                icon={(
                                    <Ionicons
                                        name="chatbubble-outline"
                                        size={20}
                                        color={theme.colors.textSecondary}
                                    />
                                )}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                </ScrollView>
            )}
        </View>
    );
}
