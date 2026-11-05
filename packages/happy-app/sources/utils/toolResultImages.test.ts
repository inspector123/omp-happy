import { describe, it, expect } from 'vitest';
import { splitToolResultImages } from './toolResultImages';

// 1x1 PNG (70 bytes) and 1x1 GIF (42 bytes).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('splitToolResultImages', () => {
    it('extracts the image from an omp read result and labels it in the text', () => {
        const result = {
            content: [
                { type: 'text', text: 'Read image file [image/png]' },
                { type: 'image', data: PNG, mimeType: 'image/png' },
            ],
            details: { fileSize: 70 },
        };

        const { images, rest } = splitToolResultImages(result);

        expect(images).toEqual([{ uri: `data:image/png;base64,${PNG}`, mimeType: 'image/png', size: 70 }]);
        expect(rest).toEqual({
            content: [
                { type: 'text', text: 'Read image file [image/png]' },
                { type: 'image', data: '[image/png, 70 B]', mimeType: 'image/png' },
            ],
            details: { fileSize: 70 },
        });
        expect(result.content[1].data).toBe(PNG);
    });

    it('reads Anthropic and Claude Code image shapes, sniffing a missing type', () => {
        const { images, rest } = splitToolResultImages([
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD' } },
            { type: 'image', file: { base64: GIF, originalSize: 42 } },
        ]);

        expect(images.map((image) => image.mimeType)).toEqual(['image/jpeg', 'image/gif']);
        expect(images[1].uri).toBe(`data:image/gif;base64,${GIF}`);
        expect(rest).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '[image/jpeg, 20 B]' } },
            { type: 'image', file: { base64: '[image/gif, 42 B]', originalSize: 42 } },
        ]);
    });

    it('finds data URI strings anywhere in the result', () => {
        const uri = `data:image/png;base64,${PNG}`;

        const { images, rest } = splitToolResultImages({ output: [{ image_url: { url: uri } }] });

        expect(images).toEqual([{ uri, mimeType: 'image/png', size: 70 }]);
        expect(rest).toEqual({ output: [{ image_url: { url: '[image/png, 70 B]' } }] });
    });

    it('leaves results without loadable images untouched', () => {
        const blobRef = {
            content: [{ type: 'image', data: 'blob:sha256:028eea344a99d6c5ad2bb2b3a418468a65842cfff30dacb6f769b142381ca168', mimeType: 'image/webp' }],
        };
        const unknownFormat = { type: 'image', data: 'AAAAIGZ0eXBhdmlm' };

        for (const result of [blobRef, unknownFormat, 'plain text output', null]) {
            const split = splitToolResultImages(result);
            expect(split.images).toEqual([]);
            expect(split.rest).toBe(result);
        }
    });
});
