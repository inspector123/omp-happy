import { describe, expect, it } from 'vitest';
import { filterPeerMessages, groupPeerMessages, sortPeerConversations } from './peerMessages';

describe('peer message conversations', () => {
    it('filters, groups, orders, and sorts conversations by newest message', () => {
        const messages = filterPeerMessages([
            {
                body: {
                    kind: 'peer_message',
                    id: 'message-a-new',
                    fromSessionId: 'sender-a',
                    fromTitle: 'Sender A',
                    toSessionId: 'target-a',
                    body: 'Newest for A',
                    replyTo: null,
                    ts: 300,
                },
            },
            { body: { kind: 'text', text: 'Ordinary feed item' } },
            {
                body: {
                    kind: 'peer_message',
                    id: 'message-b',
                    fromSessionId: 'sender-b',
                    fromTitle: 'Sender B',
                    toSessionId: 'target-b',
                    body: 'Only message for B',
                    replyTo: 'earlier-message',
                    ts: 200,
                },
            },
            {
                body: {
                    kind: 'peer_message',
                    id: 'message-a-old',
                    fromSessionId: 'sender-a',
                    fromTitle: 'Sender A',
                    toSessionId: 'target-a',
                    body: 'Oldest for A',
                    replyTo: null,
                    ts: 100,
                },
            },
            {},
            { body: { kind: 'peer_message', id: 'missing-required-fields' } },
            { body: { kind: 'future_feed_kind' } },
        ]);

        const grouped = groupPeerMessages(messages);
        const targetA = grouped.get('target-a');
        const targetB = grouped.get('target-b');

        expect(messages.map((message) => message.id)).toEqual([
            'message-a-new',
            'message-b',
            'message-a-old',
        ]);
        expect(targetA).toMatchObject({ count: 2, lastTs: 300 });
        expect(targetA?.messages.map((message) => message.id)).toEqual([
            'message-a-old',
            'message-a-new',
        ]);
        expect(targetB).toMatchObject({ count: 1, lastTs: 200 });
        expect(sortPeerConversations(grouped).map((conversation) => conversation.toSessionId)).toEqual([
            'target-a',
            'target-b',
        ]);
    });
});
