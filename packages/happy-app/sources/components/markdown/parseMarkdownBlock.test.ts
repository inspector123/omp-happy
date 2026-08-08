import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const spans = (text: string) => text ? [{ styles: [], text, url: null }] : [];

describe('parseMarkdownBlock - table parsing', () => {

    it('parses a standard table without blank lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')]],
        });
    });

    it('parses a table with blank lines between rows (LLM output)', () => {
        const md = [
            '| A | B |',
            '',
            '|---|---|',
            '',
            '| 1 | 2 |',
            '',
            '| 3 | 4 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        // Should be recognized as a single table, not 4 separate text blocks
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);
        expect(tableBlocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')], [spans('3'), spans('4')]],
        });
    });

    it('preserves empty interior cells (e.g. row header column)', () => {
        const md = [
            '| | Header1 | Header2 |',
            '|---|---|---|',
            '| Row1 | a | b |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans(''), spans('Header1'), spans('Header2')],
            rows: [[spans('Row1'), spans('a'), spans('b')]],
        });
    });

    it('handles blank lines and empty first cell combined', () => {
        const md = [
            '### Comparison',
            '',
            '| | Plan A | Plan B |',
            '',
            '|--|----|----|',
            '',
            '| Price | $10/mo | $20/mo |',
            '',
            '| Storage | 5 GB | 50 GB |',
            '',
            '| Support | Email only | 24/7 chat |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);

        const table = tableBlocks[0];
        if (table.type !== 'table') throw new Error('not a table');

        // Empty first cell should be preserved
        expect(table.headers).toHaveLength(3);
        expect(table.headers[0]).toEqual([]);

        expect(table.rows).toHaveLength(3);
        expect(table.rows[0][0]).toEqual(spans('Price'));
    });

    it('stops table collection at non-blank, non-pipe lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            'Some text after the table',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        const textBlocks = blocks.filter(b => b.type === 'text');

        expect(tableBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
    });
});

describe('parseMarkdownBlock - fenced code blocks', () => {
    it('keeps indented nested fences inside an outer Markdown fence', () => {
        const md = [
            '```markdown',
            '## Verification',
            '',
            '  ```json',
            '  {"topics":[]}',
            '  ```',
            '',
            '## Rollout',
            '',
            '1. Release Commonwedge.',
            '```',
        ].join('\n');

        expect(parseMarkdown(md)).toEqual([{
            type: 'code-block',
            language: 'markdown',
            content: [
                '## Verification',
                '',
                '  ```json',
                '  {"topics":[]}',
                '  ```',
                '',
                '## Rollout',
                '',
                '1. Release Commonwedge.',
            ].join('\n'),
        }]);
    });
});

describe('parseMarkdownBlock - display math', () => {
    it('renders text-only bracketed LaTeX without exposing delimiters or commands', () => {
        const md = [
            '\\[',
            '\\text{net delta}=\\text{market-buy volume}-\\text{market-sell volume}',
            '\\]',
        ].join('\n');

        expect(parseMarkdown(md)).toEqual([{
            type: 'text',
            content: spans('net delta=market-buy volume-market-sell volume'),
        }]);
    });

    it('renders text-only dollar-delimited LaTeX the same way', () => {
        const md = [
            '$$',
            '\\text{net delta}=\\text{market-buy volume}-\\text{market-sell volume}',
            '$$',
        ].join('\n');

        expect(parseMarkdown(md)).toEqual([{
            type: 'text',
            content: spans('net delta=market-buy volume-market-sell volume'),
        }]);
    });
});
