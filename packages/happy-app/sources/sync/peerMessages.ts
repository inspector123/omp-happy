import type { FeedBody, FeedItem } from './feedTypes';

export type PeerMessage = Extract<FeedBody, { kind: 'peer_message' }>;

export interface PeerConversation {
    toSessionId: string;
    count: number;
    lastTs: number;
    messages: PeerMessage[];
}

type FeedItemLike = Pick<FeedItem, 'body'> | { readonly body?: unknown } | null | undefined;


function isPeerMessage(value: unknown): value is PeerMessage {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as { [Key in keyof PeerMessage]?: unknown };
    if (candidate.kind !== 'peer_message') {
        return false;
    }

    return typeof candidate.id === 'string'
        && typeof candidate.fromSessionId === 'string'
        && typeof candidate.fromTitle === 'string'
        && typeof candidate.toSessionId === 'string'
        && typeof candidate.body === 'string'
        && (typeof candidate.replyTo === 'string' || candidate.replyTo === null)
        && typeof candidate.ts === 'number'
        && Number.isFinite(candidate.ts);
}

export function filterPeerMessages(items: readonly FeedItemLike[]): PeerMessage[] {
    const messages: PeerMessage[] = [];
    for (const item of items) {
        if (isPeerMessage(item?.body)) {
            messages.push(item.body);
        }
    }
    return messages;
}

export function groupPeerMessages(messages: readonly PeerMessage[]): Map<string, PeerConversation> {
    const groupedMessages = new Map<string, PeerMessage[]>();
    for (const message of messages) {
        const conversation = groupedMessages.get(message.toSessionId);
        if (conversation) {
            conversation.push(message);
        } else {
            groupedMessages.set(message.toSessionId, [message]);
        }
    }

    const conversations = new Map<string, PeerConversation>();
    for (const [toSessionId, conversationMessages] of groupedMessages) {
        const chronologicalMessages = [...conversationMessages].sort((left, right) => left.ts - right.ts);
        conversations.set(toSessionId, {
            toSessionId,
            count: chronologicalMessages.length,
            lastTs: chronologicalMessages[chronologicalMessages.length - 1].ts,
            messages: chronologicalMessages,
        });
    }
    return conversations;
}

export function sortPeerConversations(
    conversations: ReadonlyMap<string, PeerConversation>,
): PeerConversation[] {
    return [...conversations.values()].sort((left, right) => {
        const timeDifference = right.lastTs - left.lastTs;
        return timeDifference !== 0
            ? timeDifference
            : left.toSessionId.localeCompare(right.toSessionId);
    });
}
