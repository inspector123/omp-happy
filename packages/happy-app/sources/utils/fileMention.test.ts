import { describe, it, expect } from 'vitest';
import { appendFileMentions, formatFileMention } from './fileMention';

// The mention grammar omp applies to sent messages, copied from its
// file-mentions module (omp 18.4.6) so these tests pin the contract.
function ompMentionedPaths(text: string): string[] {
    const paths: string[] = [];
    for (const match of text.matchAll(/@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g)) {
        const index = match.index ?? 0;
        if (index > 0 && !/[\s([{<"'`]/.test(text[index - 1])) continue;
        const quoted = match[1] ?? match[2];
        const path = quoted !== undefined
            ? quoted.trim()
            : match[3].trim().replace(/^[`"'([{<]+/, '').replace(/[)\]}>.,;:!?"'`]+$/, '').trim();
        if (path) paths.push(path);
    }
    return paths;
}

describe('formatFileMention', () => {
    it('keeps plain paths bare', () => {
        expect(formatFileMention('src/app.ts')).toBe('@src/app.ts');
        expect(formatFileMention('.happy-uploads/IMG_1234.jpg')).toBe('@.happy-uploads/IMG_1234.jpg');
        expect(formatFileMention('docs/')).toBe('@docs/');
    });

    it('produces mentions that omp reads back as the exact path', () => {
        const paths = [
            'src/app.ts',
            '.happy-uploads/IMG (1).jpg',
            'Screenshot 2026-11-04 at 7.20 PM.png',
            'user@host.txt',
            'notes.',
            '(draft).md',
            'say "hi".txt',
            'docs/',
        ];
        for (const path of paths) {
            expect(ompMentionedPaths(`look at ${formatFileMention(path)} please`)).toEqual([path]);
        }
    });
});

describe('appendFileMentions', () => {
    it('separates mentions from existing text and leaves room to type', () => {
        expect(appendFileMentions('', ['a.txt', 'b c.pdf'])).toBe('@a.txt @"b c.pdf" ');
        expect(appendFileMentions('look at', ['a.txt'])).toBe('look at @a.txt ');
        expect(appendFileMentions('look at\n', ['a.txt'])).toBe('look at\n@a.txt ');
        expect(appendFileMentions('unchanged', [])).toBe('unchanged');
    });

    it('keeps every appended path readable by omp', () => {
        const text = appendFileMentions('compare', ['IMG (1).jpg', 'IMG (2).jpg']);
        expect(ompMentionedPaths(`${text}what changed?`)).toEqual(['IMG (1).jpg', 'IMG (2).jpg']);
    });
});
