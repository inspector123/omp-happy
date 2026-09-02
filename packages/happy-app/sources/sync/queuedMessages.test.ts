import { describe, expect, it, vi } from 'vitest';

vi.mock('./sync', () => ({
    sync: {},
}));

vi.mock('./persistence', () => ({
    loadSettings: () => ({}),
    saveSettings: vi.fn(),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    loadPurchases: () => ({}),
    savePurchases: vi.fn(),
    loadProfile: () => null,
    saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadSessionPermissionModes: () => ({}),
    saveSessionPermissionModes: vi.fn(),
    loadSessionModelModes: () => ({}),
    saveSessionModelModes: vi.fn(),
    loadSessionEffortLevels: () => ({}),
    saveSessionEffortLevels: vi.fn(),
}));

vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => null,
    getVoiceSession: () => null,
}));

vi.mock('@/components/tools/knownTools', () => ({
    isMutableTool: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            userMessageBackground: '#eee',
            agentEventText: '#666',
            input: { text: '#111' },
            divider: '#ddd',
            groupped: { background: '#fafafa' },
        },
    };
    return {
        StyleSheet: {
            create: (styles: unknown) => (
                typeof styles === 'function'
                    ? (styles as (value: typeof theme) => unknown)(theme)
                    : styles
            ),
        },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('../components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
    Option: undefined,
}));

vi.mock('../components/tools/ToolView', () => ({
    ToolView: 'ToolView',
}));

vi.mock('../components/layout', () => ({
    layout: { maxWidth: 800 },
}));


import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
    editQueuedMessageWithDraftProtection,
    isQueuedMessageSafeToEdit,
    storage,
} from './storage';
import type { UserTextMessage } from './typesMessage';
import { MessageView } from '../components/MessageView';
import type { NormalizedMessage } from './typesRaw';

function optimisticUserMessage(localId: string, text: string, createdAt = 1000): NormalizedMessage {
    return {
        id: localId,
        localId,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false,
        meta: undefined,
    };
}

describe('queued message store contract', () => {
    it('tracks queued and safely editable localIds independently', () => {
        storage.getState().applyQueuedMessages('q1', [
            { localId: 'a', editable: true },
            { localId: 'b', editable: false },
        ]);
        expect(storage.getState().queuedMessages['q1']).toEqual(['a', 'b']);
        expect(storage.getState().editableQueuedMessages['q1']).toEqual(['a']);

        storage.getState().applyQueuedMessages('q1', [{ localId: 'b', editable: false }]);
        expect(storage.getState().queuedMessages['q1']).toEqual(['b']);
        expect(storage.getState().editableQueuedMessages['q1']).toBeUndefined();

        storage.getState().applyQueuedMessages('q1', []);
        expect(storage.getState().queuedMessages['q1']).toBeUndefined();
        expect(storage.getState().editableQueuedMessages['q1']).toBeUndefined();
    });

    it('never makes attachment sends or their file records editable', () => {
        const fileRecord = {
            localId: 'attachment-file',
            hasAttachments: true,
            postAttempted: false,
        };
        const textRecord = {
            localId: 'attachment-text',
            text: 'caption',
            hasAttachments: true,
            postAttempted: false,
        };

        expect(isQueuedMessageSafeToEdit(fileRecord)).toBe(false);
        expect(isQueuedMessageSafeToEdit(textRecord)).toBe(false);
        storage.getState().applyQueuedMessages('q-attachments', [fileRecord, textRecord].map((message) => ({
            localId: message.localId,
            editable: isQueuedMessageSafeToEdit(message),
        })));
        expect(storage.getState().queuedMessages['q-attachments']).toEqual([
            'attachment-file',
            'attachment-text',
        ]);
        expect(storage.getState().editableQueuedMessages['q-attachments']).toBeUndefined();
    });

    it('keeps a message queued but permanently disables editing after a POST attempt', () => {
        const message = {
            localId: 'ambiguous-send',
            text: 'possibly accepted',
            hasAttachments: false,
            postAttempted: false,
        };
        expect(isQueuedMessageSafeToEdit(message)).toBe(true);

        message.postAttempted = true;
        storage.getState().applyQueuedMessages('q-attempted', [{
            localId: message.localId,
            editable: isQueuedMessageSafeToEdit(message),
        }]);

        expect(storage.getState().queuedMessages['q-attempted']).toEqual(['ambiguous-send']);
        expect(storage.getState().editableQueuedMessages['q-attempted']).toBeUndefined();
        expect(isQueuedMessageSafeToEdit(message)).toBe(false);
    });

    it('successfully pulls a safe offline text message into an empty composer', async () => {
        const confirmReplaceDraft = vi.fn(async () => true);
        const removeQueuedMessage = vi.fn(() => 'safe offline text');
        const replaceDraft = vi.fn();
        const clearAttachments = vi.fn();

        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => '',
            getCurrentAttachmentIds: () => [],
            confirmReplaceDraft,
            removeQueuedMessage,
            clearAttachments,
            replaceDraft,
        });

        expect(outcome).toBe('edited');
        expect(confirmReplaceDraft).not.toHaveBeenCalled();
        expect(removeQueuedMessage).toHaveBeenCalledOnce();
        expect(replaceDraft).toHaveBeenCalledWith('safe offline text');
        expect(clearAttachments).toHaveBeenCalledOnce();
    });

    it('preserves newer composer text and images and leaves the outbox untouched on cancel', async () => {
        let draft = 'newer draft';
        const attachmentIds = ['newer-image'];
        const clearAttachments = vi.fn(() => attachmentIds.splice(0));
        const removeQueuedMessage = vi.fn(() => 'older queued text');
        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => draft,
            getCurrentAttachmentIds: () => attachmentIds,
            confirmReplaceDraft: async () => false,
            removeQueuedMessage,
            clearAttachments,
            replaceDraft: (text) => {
                draft = text;
            },
        });

        expect(outcome).toBe('cancelled');
        expect(removeQueuedMessage).not.toHaveBeenCalled();
        expect(draft).toBe('newer draft');
        expect(attachmentIds).toEqual(['newer-image']);
        expect(clearAttachments).not.toHaveBeenCalled();
    });

    it('removes from the outbox only after accepting the draft replacement', async () => {
        const events: string[] = [];
        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => 'newer draft',
            getCurrentAttachmentIds: () => ['draft-image'],
            confirmReplaceDraft: async () => {
                events.push('accepted');
                return true;
            },
            removeQueuedMessage: () => {
                events.push('removed');
                return 'queued text';
            },
            clearAttachments: () => {
                events.push('cleared');
            },
            replaceDraft: () => {
                events.push('replaced');
            },
        });

        expect(outcome).toBe('edited');
        expect(events).toEqual(['accepted', 'removed', 'cleared', 'replaced']);
    });

    it('confirms and clears an image-only draft before restoring queued text', async () => {
        let draft = '';
        const attachmentIds = ['image-only'];
        const confirmReplaceDraft = vi.fn(async () => true);
        const removeQueuedMessage = vi.fn(() => 'queued text');

        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => draft,
            getCurrentAttachmentIds: () => attachmentIds,
            confirmReplaceDraft,
            removeQueuedMessage,
            clearAttachments: () => attachmentIds.splice(0),
            replaceDraft: (text) => {
                draft = text;
            },
        });

        expect(outcome).toBe('edited');
        expect(confirmReplaceDraft).toHaveBeenCalledOnce();
        expect(removeQueuedMessage).toHaveBeenCalledOnce();
        expect(attachmentIds).toEqual([]);
        expect(draft).toBe('queued text');
    });

    it('confirms again when selected image IDs change while confirmation is open', async () => {
        let draft = 'current text';
        const attachmentIds = ['older-image'];
        const confirmedSnapshots: string[][] = [];
        const confirmReplaceDraft = vi.fn(async () => {
            confirmedSnapshots.push([...attachmentIds]);
            if (confirmedSnapshots.length === 1) {
                attachmentIds[0] = 'newer-image';
            }
            return true;
        });

        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => draft,
            getCurrentAttachmentIds: () => attachmentIds,
            confirmReplaceDraft,
            removeQueuedMessage: () => 'queued text',
            clearAttachments: () => attachmentIds.splice(0),
            replaceDraft: (text) => {
                draft = text;
            },
        });

        expect(outcome).toBe('edited');
        expect(confirmedSnapshots).toEqual([['older-image'], ['newer-image']]);
        expect(attachmentIds).toEqual([]);
        expect(draft).toBe('queued text');
    });

    it('preserves current text and images when queued-message removal becomes unavailable', async () => {
        let draft = 'current text';
        const attachmentIds = ['current-image'];
        const clearAttachments = vi.fn(() => attachmentIds.splice(0));
        const replaceDraft = vi.fn((text: string) => {
            draft = text;
        });

        const outcome = await editQueuedMessageWithDraftProtection({
            getCurrentDraft: () => draft,
            getCurrentAttachmentIds: () => attachmentIds,
            confirmReplaceDraft: async () => true,
            removeQueuedMessage: () => null,
            clearAttachments,
            replaceDraft,
        });

        expect(outcome).toBe('unavailable');
        expect(clearAttachments).not.toHaveBeenCalled();
        expect(replaceDraft).not.toHaveBeenCalled();
        expect(attachmentIds).toEqual(['current-image']);
        expect(draft).toBe('current text');
    });

    it('renders an editable queued no-argument command with a long-press action until it leaves the queue', () => {
        const sessionId = 'q-slash';
        const localId = 'slash-local';
        const message: UserTextMessage = {
            kind: 'user-text',
            id: localId,
            localId,
            createdAt: 1000,
            text: '/compact',
        };
        storage.getState().applyQueuedMessages(sessionId, [{ localId, editable: true }]);

        const onEditQueuedMessage = vi.fn();
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(MessageView, {
                message,
                metadata: null,
                sessionId,
                onEditQueuedMessage,
            }));
        });
        const queuedTree = JSON.stringify(renderer.toJSON());
        expect(queuedTree).toContain('compact');
        expect(queuedTree).toContain('message.queued');
        const commandChip = renderer.root.findByProps({ delayLongPress: 400 });
        expect(commandChip.props.onLongPress).toBeTypeOf('function');
        act(() => {
            commandChip.props.onLongPress();
        });
        expect(onEditQueuedMessage).toHaveBeenCalledOnce();
        expect(onEditQueuedMessage).toHaveBeenCalledWith(message);

        act(() => {
            storage.getState().applyQueuedMessages(sessionId, [{ localId, editable: false }]);
        });
        expect(renderer.root.findByProps({ delayLongPress: 400 }).props.onLongPress).toBeUndefined();

        act(() => {
            storage.getState().applyQueuedMessages(sessionId, []);
        });
        const sentTree = JSON.stringify(renderer.toJSON());
        expect(sentTree).not.toContain('compact');
        expect(sentTree).not.toContain('message.queued');
        act(() => renderer.unmount());
    });

    it('removeMessage drops the optimistic message and lets the same localId be re-added later', () => {
        const sessionId = 'q2';
        storage.getState().applyMessages(sessionId, [optimisticUserMessage('local-1', 'hello')]);

        let session = storage.getState().sessionMessages[sessionId];
        expect(session.messages).toHaveLength(1);
        const first = session.messages[0];
        expect(first.kind).toBe('user-text');
        expect(first.kind === 'user-text' && first.localId).toBe('local-1');
        expect(session.reducerState.localIds.has('local-1')).toBe(true);

        storage.getState().removeMessage(sessionId, 'local-1');

        session = storage.getState().sessionMessages[sessionId];
        expect(session.messages).toHaveLength(0);
        expect(Object.keys(session.messagesMap)).toHaveLength(0);
        // Dedup keys must be cleaned, or the reducer would either swallow a
        // legitimate re-send of the same localId or leak stale entries.
        expect(session.reducerState.localIds.has('local-1')).toBe(false);
        expect(session.reducerState.messageIds.has('local-1')).toBe(false);

        // Re-adding the same localId (e.g. user edits and re-sends) must work.
        storage.getState().applyMessages(sessionId, [optimisticUserMessage('local-1', 'hello, edited')]);
        session = storage.getState().sessionMessages[sessionId];
        expect(session.messages).toHaveLength(1);
        expect(session.messages[0].kind === 'user-text' && session.messages[0].text).toBe('hello, edited');
    });

    it('orders a slow local-model response after its optimistic user prompt despite clock skew', () => {
        const sessionId = 'q-order';
        storage.getState().applyMessages(sessionId, [
            optimisticUserMessage('local-order', 'Hi', 2_000),
        ]);

        const serverEcho: NormalizedMessage = {
            ...optimisticUserMessage('local-order', 'Hi', 900),
            id: 'server-user',
            seq: 10,
        };
        const streamedReasoning: NormalizedMessage = {
            id: 'server-reasoning',
            localId: null,
            createdAt: 1_000,
            seq: 11,
            role: 'agent',
            content: [{
                type: 'thinking',
                thinking: 'Working slowly',
                uuid: 'reasoning-uuid',
                parentUUID: null,
            }],
            isSidechain: false,
            meta: undefined,
        };

        storage.getState().applyMessages(sessionId, [serverEcho, streamedReasoning]);

        const messages = storage.getState().sessionMessages[sessionId].messages;
        // ChatList is inverted, so newest-first data renders the user prompt
        // above the subsequent reasoning block.
        expect(messages.map((message) => message.kind)).toEqual(['agent-text', 'user-text']);
        expect(messages[1].serverSeq).toBe(10);
        expect(messages[0].serverSeq).toBe(11);
    });

    it('removeMessage ignores unknown localIds without touching state', () => {
        const sessionId = 'q3';
        storage.getState().applyMessages(sessionId, [optimisticUserMessage('local-9', 'keep me')]);
        const before = storage.getState().sessionMessages[sessionId];

        storage.getState().removeMessage(sessionId, 'does-not-exist');
        storage.getState().removeMessage('no-such-session', 'local-9');

        const after = storage.getState().sessionMessages[sessionId];
        expect(after.messages).toHaveLength(1);
        expect(after.messages).toBe(before.messages);
    });
});
