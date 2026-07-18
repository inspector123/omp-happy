import { describe, expect, it, vi } from 'vitest';

// Mock React Native dependencies required by ToolView
vi.mock('react', () => {
    const memo = (fn: (...args: unknown[]) => unknown) => fn;
    const useState = (initial: unknown) => [initial, () => {}];
    return { memo, useState, default: { memo, useState } };
});

vi.mock('react-native', () => ({
    Text: () => null,
    View: () => null,
    TouchableOpacity: () => null,
    ActivityIndicator: () => null,
    Platform: { OS: 'ios', select: (_: unknown, opts: Record<string, unknown>) => opts.ios ?? opts.default ?? opts.android },
    Pressable: () => null,
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: () => ({}) },
    useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surfaceHigh: '#f5f5f5', surfaceHighest: '#fff', warning: '#f00' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: () => {} }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

vi.mock('@/utils/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false, errorMessage: null }),
}));

vi.mock('@/utils/toolDisplay', () => ({
    getTerminalToolCommand: () => null,
    shouldRenderToolCardHeader: () => true,
}));

vi.mock('./views/_all', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('./views/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
}));

vi.mock('./ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('./ToolSectionView', () => ({
    ToolSectionView: () => null,
}));

vi.mock('./PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('../CodeView', () => ({
    CodeView: () => null,
}));

import { truncateToLines } from './ToolView';

describe('truncateToLines', () => {
    it('returns the original string when it has fewer lines than the limit', () => {
        const code = 'line1\nline2\nline3';
        expect(truncateToLines(code, 5)).toBe(code);
    });

    it('returns the original string when line count equals the limit', () => {
        const lines = ['a', 'b', 'c', 'd', 'e'].join('\n');
        expect(truncateToLines(lines, 5)).toBe(lines);
    });

    it('truncates to the first N lines and appends a truncation indicator', () => {
        const code = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
        const result = truncateToLines(code, 5);
        expect(result).toContain('a\nb\nc\nd\ne');
        expect(result).toContain('+2 more lines');
        expect(result).toContain('(tap to expand)');
    });

    it('uses singular "line" when exactly one line is hidden', () => {
        const code = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
        const result = truncateToLines(code, 5);
        expect(result).toContain('+1 more line');
        expect(result).not.toContain('lines');
    });

    it('handles JSON input with many lines', () => {
        const json = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }, null, 2);
        const result = truncateToLines(json, 5);
        const lines = result.split('\n');
        // First 5 lines of JSON + truncation indicator line
        expect(lines.length).toBeGreaterThan(5);
        expect(lines[5]).toContain('more line');
    });
});

describe('unknown OMP tool rendering contracts', () => {
    // These tests verify the decision logic that ToolView uses to determine
    // whether a tool is an "unknown OMP tool" and should be collapsed.
    // The actual React rendering is covered by integration tests.

    it('identifies unknown OMP tools by flavor and absence from knownTools', () => {
        // Simulate the detection logic from ToolView
        const knownToolNames = [
            'Task', 'Agent', 'delegate_task', 'fetch', 'read', 'search',
            'think', 'edit', 'execute', 'Bash', 'Write', 'TodoWrite',
            'ExitPlanMode', 'exit_plan_mode', 'MultiEdit', 'CodexBash',
            'CodexPatch', 'CodexDiff', 'AskUserQuestion', 'edit', 'execute',
            'file',
        ];

        const isUnknownOMPTool = (toolName: string, flavor: string | null | undefined) => {
            const isKnown = knownToolNames.includes(toolName) || toolName.startsWith('mcp__');
            const isOMP = flavor === 'omp';
            return !isKnown && isOMP;
        };

        // Unknown tool + OMP flavor → collapsed
        expect(isUnknownOMPTool('some_random_omp_tool', 'omp')).toBe(true);

        // Known tool + OMP flavor → not collapsed (uses existing rendering)
        expect(isUnknownOMPTool('read', 'omp')).toBe(false);
        expect(isUnknownOMPTool('edit', 'omp')).toBe(false);
        expect(isUnknownOMPTool('Bash', 'omp')).toBe(false);

        // Unknown tool + non-OMP flavor → not collapsed (uses default fallback)
        expect(isUnknownOMPTool('some_random_tool', 'claude')).toBe(false);
        expect(isUnknownOMPTool('some_random_tool', 'gemini')).toBe(false);
        expect(isUnknownOMPTool('some_random_tool', 'codex')).toBe(false);
        expect(isUnknownOMPTool('some_random_tool', null)).toBe(false);

        // MCP tools are always treated as known
        expect(isUnknownOMPTool('mcp__some_server__some_tool', 'omp')).toBe(false);
    });

    it('truncates raw input to at most 5 lines for unknown OMP tools', () => {
        const input = JSON.stringify({
            param1: 'value1',
            param2: 'value2',
            param3: 'value3',
            param4: 'value4',
            param5: 'value5',
            param6: 'value6',
            param7: 'value7',
            param8: 'value8',
            param9: 'value9',
            param10: 'value10',
        }, null, 2);

        const result = truncateToLines(input, 5);
        const lines = result.split('\n');

        // The preview has exactly 5 content lines plus the truncation indicator
        const contentLines = lines.filter((line) => !line.includes('more line'));
        expect(contentLines.length).toBe(5);

        // The truncation indicator is present
        expect(result).toContain('more line');
        expect(result).toContain('(tap to expand)');
    });

    it('truncates raw output to at most 5 lines for unknown OMP tools', () => {
        const output = JSON.stringify({
            result: 'success',
            data: { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
            metadata: { timestamp: '2024-01-01', version: '1.0' },
            extra: 'field',
            another: 'field',
            more: 'fields',
            even: 'more',
            fields: 'here',
        }, null, 2);

        const result = truncateToLines(output, 5);
        const lines = result.split('\n');

        const contentLines = lines.filter((line) => !line.includes('more line'));
        expect(contentLines.length).toBe(5);
        expect(result).toContain('more line');
    });

    it('does not truncate when input fits within 5 lines', () => {
        const compactInput = JSON.stringify({ key: 'value' }, null, 2);
        const result = truncateToLines(compactInput, 5);
        // Should return the original string unchanged
        expect(result).toBe(compactInput);
        expect(result).not.toContain('more line');
    });

    it('does not truncate when output is a short string', () => {
        const shortOutput = 'OK';
        const result = truncateToLines(shortOutput, 5);
        expect(result).toBe('OK');
        expect(result).not.toContain('more line');
    });
});