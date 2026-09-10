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

    it('attaches a PTY password request to its running terminal tool', () => {
        const state = createReducer();
        const bashMessage: NormalizedMessage = {
            id: 'bash-message',
            localId: null,
            createdAt: 1_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'bash-1',
                name: 'execute',
                input: { command: 'sudo -k true', pty: true },
                description: null,
                uuid: 'bash-message',
                parentUUID: null,
            }],
        };
        const promptMessage: NormalizedMessage = {
            id: 'prompt-message',
            localId: null,
            createdAt: 1_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'prompt-1',
                name: 'AskUserQuestion',
                input: {
                    inputKind: 'password',
                    questions: [{
                        id: 'password',
                        question: '[sudo] password for zarathustra:',
                        header: 'Authentication',
                        options: [],
                        secret: true,
                    }],
                },
                description: '[sudo] password for zarathustra:',
                uuid: 'prompt-message',
                parentUUID: null,
                parentToolCallId: 'bash-1',
            }],
        };

        reducer(state, [bashMessage]);
        const result = reducer(state, [promptMessage]);
        const terminalMessage = result.messages.find(item => 'tool' in item && item.tool.name === 'execute');
        const terminal = terminalMessage && 'tool' in terminalMessage ? terminalMessage.tool : undefined;

        expect(result.messages).toHaveLength(1);
        expect(terminal?.state).toBe('running');
        expect(terminal?.inlineRequest).toMatchObject({
            name: 'AskUserQuestion',
            state: 'running',
            input: { inputKind: 'password' },
            permission: {
                id: 'prompt-1',
                status: 'pending',
            },
        });
    });
});
