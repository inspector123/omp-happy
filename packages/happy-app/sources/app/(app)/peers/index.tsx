import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { layout } from '@/components/layout';
import { Typography } from '@/constants/Typography';
import { useFeedItems, useSession } from '@/sync/storage';
import { filterPeerMessages, groupPeerMessages, sortPeerConversations, type PeerConversation } from '@/sync/peerMessages';
import { formatLastSeen, getSessionName } from '@/utils/sessionUtils';
import { useHeaderHeight } from '@/utils/responsive';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    backButton: {
        marginRight: 16,
    },
    headerTitle: {
        fontSize: 17,
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
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

function ConversationRow({ conversation }: { conversation: PeerConversation }) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const session = useSession(conversation.toSessionId);
    const newestMessage = conversation.messages[conversation.messages.length - 1];
    const targetTitle = session?.metadata
        ? getSessionName(session)
        : `Session ${conversation.toSessionId.slice(0, 8)}`;

    return (
        <Item
            title={targetTitle}
            subtitle={`${t('peers.from', { name: newestMessage.fromTitle })}: ${newestMessage.body}`}
            detail={formatLastSeen(conversation.lastTs)}
            icon={<Ionicons name="chatbubbles-outline" size={20} color={theme.colors.textSecondary} />}
            onPress={() => router.push({
                pathname: '/peers/[sessionId]',
                params: { sessionId: conversation.toSessionId },
            } as never)}
            showChevron={true}
        />
    );
}

export default function PeerConversationsScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const feedItems = useFeedItems();
    const conversations = React.useMemo(
        () => sortPeerConversations(groupPeerMessages(filterPeerMessages(feedItems))),
        [feedItems],
    );

    return (
        <View style={styles.container}>
            <View style={[styles.header, { paddingTop: insets.top }]}>
                <View style={[styles.headerContent, { height: headerHeight }]}>
                    <Pressable
                        onPress={() => router.back()}
                        style={styles.backButton}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={24}
                            color={theme.colors.header.tint}
                        />
                    </Pressable>
                    <Text style={styles.headerTitle}>{t('peers.title')}</Text>
                </View>
            </View>

            {conversations.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>{t('peers.empty')}</Text>
                </View>
            ) : (
                <ScrollView contentContainerStyle={styles.content}>
                    <ItemGroup title={t('peers.title')}>
                        {conversations.map((conversation) => (
                            <ConversationRow
                                key={conversation.toSessionId}
                                conversation={conversation}
                            />
                        ))}
                    </ItemGroup>
                </ScrollView>
            )}
        </View>
    );
}
