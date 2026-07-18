/**
 * Native (iOS/Android) impl: append a Uint8Array to FormData for a multipart
 * upload. RN's Blob polyfill rejects `new Blob([arrayBuffer])`, so we stage
 * the bytes to a temp file in cacheDirectory and use RN FormData's
 * `{ uri, type, name }` form, which the platform multipart writer streams
 * directly off disk. Returns a cleanup that deletes the temp file.
 */
import { encodeBase64 } from '@/encryption/base64';
import {
    writeAsStringAsync,
    deleteAsync,
    cacheDirectory,
    EncodingType,
    FileSystemUploadType,
    uploadAsync,
} from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';

async function stageBytes(bytes: Uint8Array): Promise<{ uri: string; cleanup: () => Promise<void> }> {
    if (!cacheDirectory) {
        throw new Error('cacheDirectory unavailable on this platform');
    }
    const uri = `${cacheDirectory}happy-upload-${randomUUID()}`;
    await writeAsStringAsync(uri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
    return {
        uri,
        cleanup: async () => {
            try { await deleteAsync(uri, { idempotent: true }); } catch { /* best effort */ }
        },
    };
}

export async function appendFormFile(
    formData: FormData,
    bytes: Uint8Array,
    field: string,
    filename: string,
    contentType: string,
): Promise<() => Promise<void>> {
    const staged = await stageBytes(bytes);
    // RN typings don't know about the {uri, type, name} form, but the runtime does.
    formData.append(field, { uri: staged.uri, type: contentType, name: filename } as unknown as Blob);
    return staged.cleanup;
}

export async function uploadBinaryFile(
    url: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; statusText: string }> {
    const staged = await stageBytes(bytes);
    try {
        const result = await uploadAsync(url, staged.uri, {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers,
        });
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            statusText: result.body,
        };
    } finally {
        await staged.cleanup();
    }
}
