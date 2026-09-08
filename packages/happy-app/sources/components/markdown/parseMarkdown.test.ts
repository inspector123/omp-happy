import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const item = (spans: { styles: string[]; text: string; url: string | null }[]) => ({
    depth: 0,
    spans,
});

describe('parseMarkdown', () => {
    it('parses unordered lists across common markdown bullet markers and preserves clickable links', () => {
        const blocks = parseMarkdown([
            '* first item',
            '+ second item with [docs](https://example.com/docs)',
            '- third item with https://example.com/raw.',
        ].join('\n'));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('list');

        if (blocks[0]?.type !== 'list') {
            throw new Error('Expected markdown list block');
        }

        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[1]).toEqual(item([
            { styles: [], text: 'second item with ', url: null },
            { styles: [], text: 'docs', url: 'https://example.com/docs' },
        ]));
        expect(blocks[0].items[2]).toEqual(item([
            { styles: [], text: 'third item with ', url: null },
            { styles: [], text: 'https://example.com/raw', url: 'https://example.com/raw' },
            { styles: [], text: '.', url: null },
        ]));
    });

    it('parses standalone markdown image blocks', () => {
        const blocks = parseMarkdown('![Markdown renderable image](data:image/png;base64,abc123)');

        expect(blocks).toEqual([
            {
                type: 'image',
                alt: 'Markdown renderable image',
                url: 'data:image/png;base64,abc123',
            },
        ]);
    });

    it('auto-linkifies bare URLs in text blocks', () => {
        const blocks = parseMarkdown('Visit https://example.com/docs for more.');

        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.type).toBe('text');

        if (blocks[0]?.type !== 'text') {
            throw new Error('Expected markdown text block');
        }

        expect(blocks[0].content).toEqual([
            { styles: [], text: 'Visit ', url: null },
            { styles: [], text: 'https://example.com/docs', url: 'https://example.com/docs' },
            { styles: [], text: ' for more.', url: null },
        ]);
    });

    it('renders inline LaTeX as readable text without exposing delimiters', () => {
        const blocks = parseMarkdown([
            'The **Fisher probability** is the one-sided Fisher exact-test \\(p\\)-value.',
            '- Candidate state: \\(21/56 = 37.5\\%\\)',
        ].join('\n'));

        expect(blocks).toEqual([
            {
                type: 'text',
                content: [
                    { styles: [], text: 'The ', url: null },
                    { styles: ['bold'], text: 'Fisher probability', url: null },
                    { styles: [], text: ' is the one-sided Fisher exact-test p-value.', url: null },
                ],
            },
            {
                type: 'list',
                items: [item([
                    { styles: [], text: 'Candidate state: 21/56 = 37.5%', url: null },
                ])],
            },
        ]);
    });

    it('renders dollar-delimited math in financial prose and bold list items', () => {
        const blocks = parseMarkdown([
            '1. Best peak of **$203.8\\times$** on $MEME ($664k $\\to$ $135.3M).',
            '2. The **$2\\times-3\\times$ Scalp Bots**',
            '- Tokens reached $\\ge 10\\times$; take profit at $5\\times-50\\times+$.',
            '- Enter at $2\\times$, exit at $2.0\\times-2.5\\times$.',
        ].join('\n'));

        expect(blocks).toEqual([
            {
                type: 'numbered-list',
                items: [
                    { number: 1, ...item([
                        { styles: [], text: 'Best peak of ', url: null },
                        { styles: ['bold'], text: '203.8×', url: null },
                        { styles: [], text: ' on $MEME ($664k → $135.3M).', url: null },
                    ]) },
                    { number: 2, ...item([
                        { styles: [], text: 'The ', url: null },
                        { styles: ['bold'], text: '2×-3× Scalp Bots', url: null },
                    ]) },
                ],
            },
            {
                type: 'list',
                items: [
                    item([{ styles: [], text: 'Tokens reached ≥ 10×; take profit at 5×-50×+.', url: null }]),
                    item([{ styles: [], text: 'Enter at 2×, exit at 2.0×-2.5×.', url: null }]),
                ],
            },
        ]);
    });

    it('preserves currency, escaped dollars, code, and unfinished dollar math', () => {
        const text = String.raw`$5 to $10, $MEME and $SOL, \$5\times$, $2\times`;
        expect(parseMarkdown(text)).toEqual([
            { type: 'text', content: [{ styles: [], text, url: null }] },
        ]);
        expect(parseMarkdown('`$2\\times$` and $2\\times$')).toEqual([
            { type: 'text', content: [
                { styles: ['code'], text: '$2\\times$', url: null },
                { styles: [], text: ' and 2×', url: null },
            ] },
        ]);
    });
});
