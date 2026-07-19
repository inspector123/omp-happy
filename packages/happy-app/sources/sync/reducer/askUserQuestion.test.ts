import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';

describe('AskUserQuestion reducer', () => {
    it('creates a pending permission for direct OMP ask tool calls', () => {
        const state = createReducer();
        const message: NormalizedMessage = {
            id: 'message-1',
            localId: null,
            createdAt: 1_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'ask-1',
                name: 'AskUserQuestion',
                input: {
                    questions: [{
                        id: 'gender',
                        question: 'Select a response.',
                        header: 'Gender',
                        options: [{ label: 'Male' }, { label: 'Female' }],
                        multi: false,
                    }],
                },
                description: 'Select a response.',
                uuid: 'message-1',
                parentUUID: null,
            }],
        };

        const result = reducer(state, [message]);
        expect(state.permissions.has('ask-1')).toBe(false);
        const askMessage = result.messages.find(item => 'tool' in item && item.tool.name === 'AskUserQuestion');
        const ask = askMessage && 'tool' in askMessage ? askMessage.tool : undefined;

        expect(ask).toMatchObject({
            name: 'AskUserQuestion',
            state: 'running',
            permission: {
                id: 'ask-1',
                status: 'pending',
            },
        });
    });
});
