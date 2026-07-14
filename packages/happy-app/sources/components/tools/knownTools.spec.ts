import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { knownTools } from './knownTools';
import type { ToolCall } from '@/sync/typesMessage';

describe('knownTools', () => {
    it('hides Claude Skill tool calls from chat rendering', () => {
        expect((knownTools as Record<string, { hidden?: boolean }>).Skill?.hidden).toBe(true);
    });

    it('renders OMP read and write paths instead of generic file labels', () => {
        const baseTool: Omit<ToolCall, 'name' | 'input'> = {
            state: 'completed',
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
        };
        const readTool: ToolCall = { ...baseTool, name: 'read', input: { path: 'tmp/input.txt' } };
        const writeTool: ToolCall = { ...baseTool, name: 'write', input: { path: 'tmp/output.txt' } };

        expect(knownTools.read.title({ metadata: null, tool: readTool })).toBe('tmp/input.txt');
        expect(knownTools.write.title({ metadata: null, tool: writeTool })).toBe('tmp/output.txt');
    });

    it('renders completed OMP edit operations using their actual operation', () => {
        const baseTool: Omit<ToolCall, 'result'> = {
            name: 'edit',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
        };
        const deleteTool: ToolCall = {
            ...baseTool,
            result: { details: { op: 'delete', path: 'tmp/old.txt' } },
        };
        const moveTool: ToolCall = {
            ...baseTool,
            result: {
                details: {
                    op: 'update',
                    path: 'tmp/new.txt',
                    sourcePath: 'tmp/old.txt',
                    move: 'tmp/new.txt',
                },
            },
        };
        const copyTool: ToolCall = {
            ...baseTool,
            result: { details: { op: 'copy', path: 'tmp/copy.txt' } },
        };

        expect(knownTools.edit.title({ metadata: null, tool: deleteTool })).toBe('Delete: tmp/old.txt');
        expect(knownTools.edit.title({ metadata: null, tool: moveTool })).toBe('Move: tmp/old.txt → tmp/new.txt');
        expect(knownTools.edit.title({ metadata: null, tool: copyTool })).toBe('Copy: tmp/copy.txt');
    });
});
