import { formatBytes } from './formatBytes';

export type ToolResultImage = {
    /** `data:` URI that an Image component renders directly. */
    uri: string;
    mimeType: string;
    /** Decoded size in bytes. */
    size: number;
};

export type ToolResultImageSplit = {
    images: ToolResultImage[];
    /**
     * The result with every image payload replaced by a short label such as
     * `[image/png, 245 KB]`, for the text view. It is the original value when
     * the result holds no image.
     */
    rest: unknown;
};

const MAX_DEPTH = 8;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_MIME = /^image\/[\w.+-]+$/;

/**
 * Finds base64 images inside a tool result so tool views can show them as
 * pictures instead of raw text. Recognized shapes:
 * - `{ type: 'image', data, mimeType }` from omp, pi and MCP tool results
 * - `{ type: 'image', source: { data, media_type } }` from Anthropic content blocks
 * - `{ type: 'image', file: { base64, type } }` from Claude Code Read results
 * - any `data:image/...;base64,...` string
 *
 * A payload that is not base64, such as an omp `blob:sha256:` storage
 * reference, is left alone because the app has no way to load it.
 */
export function splitToolResultImages(result: unknown): ToolResultImageSplit {
    const images: ToolResultImage[] = [];
    const rest = visit(result, images, 0);
    return { images, rest };
}

// Returns the same reference when nothing below `value` changed, so a result
// without images comes back untouched.
function visit(value: unknown, images: ToolResultImage[], depth: number): unknown {
    if (typeof value === 'string') {
        const image = fromDataUri(value);
        if (!image) return value;
        images.push(image);
        return label(image);
    }
    if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const visited = visit(item, images, depth + 1);
            if (visited !== item) changed = true;
            return visited;
        });
        return changed ? next : value;
    }
    const record = value as Record<string, unknown>;
    const block = imageBlock(record);
    if (block) {
        images.push(block.image);
        return block.withPayload(label(block.image));
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
        const visited = visit(item, images, depth + 1);
        if (visited !== item) changed = true;
        next[key] = visited;
    }
    return changed ? next : value;
}

type ImageBlock = {
    image: ToolResultImage;
    withPayload: (text: string) => Record<string, unknown>;
};

function imageBlock(record: Record<string, unknown>): ImageBlock | null {
    if (record.type !== 'image') return null;
    if (typeof record.data === 'string') {
        const image = toImage(record.data, record.mimeType ?? record.mime_type ?? record.media_type);
        return image ? { image, withPayload: (text) => ({ ...record, data: text }) } : null;
    }
    const source = asRecord(record.source);
    if (source && typeof source.data === 'string') {
        const image = toImage(source.data, source.media_type ?? source.mimeType);
        return image ? { image, withPayload: (text) => ({ ...record, source: { ...source, data: text } }) } : null;
    }
    const file = asRecord(record.file);
    if (file && typeof file.base64 === 'string') {
        const image = toImage(file.base64, file.type);
        return image ? { image, withPayload: (text) => ({ ...record, file: { ...file, base64: text } }) } : null;
    }
    return null;
}

function toImage(payload: string, declaredMime: unknown): ToolResultImage | null {
    const fromUri = fromDataUri(payload);
    if (fromUri) return fromUri;
    if (!BASE64.test(payload)) return null;
    const mimeType = typeof declaredMime === 'string' && IMAGE_MIME.test(declaredMime)
        ? declaredMime
        : sniffMime(payload);
    if (!mimeType) return null;
    return { uri: `data:${mimeType};base64,${payload}`, mimeType, size: decodedSize(payload) };
}

function fromDataUri(value: string): ToolResultImage | null {
    if (!value.startsWith('data:image/')) return null;
    const marker = value.indexOf(';base64,');
    if (marker < 0) return null;
    const mimeType = value.slice('data:'.length, marker);
    const payload = value.slice(marker + ';base64,'.length);
    if (!IMAGE_MIME.test(mimeType) || !BASE64.test(payload)) return null;
    return { uri: value, mimeType, size: decodedSize(payload) };
}

// Each format's magic bytes, as they appear at the start of the base64 text.
// WebP starts with "RIFF", and its "EBP" of "WEBP" encodes to "RUJQ" at
// characters 12-15.
function sniffMime(base64: string): string | null {
    if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR') && base64.slice(12, 16) === 'RUJQ') return 'image/webp';
    return null;
}

function decodedSize(base64: string): number {
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
}

function label(image: ToolResultImage): string {
    return `[${image.mimeType}, ${formatBytes(image.size)}]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}
