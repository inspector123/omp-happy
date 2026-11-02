/**
 * Native (iOS/Android) impl: decrypted attachments become real files in the
 * app cache so expo-video can stream them and the share sheet can hand them
 * to Photos, Files, Drive, or another app. Web counterpart: attachmentFile.web.ts.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Write decrypted bytes under the cache, keyed by the server ref so repeated
 * opens reuse the file, and named after the original file so shares keep it.
 */
export async function writeAttachmentFile(ref: string, bytes: Uint8Array, name: string, _mimeType: string): Promise<string> {
    const refKey = (ref.split('/').pop() ?? ref).replace(/\.enc$/, '').replace(/[^A-Za-z0-9_-]/g, '_');
    const directory = new Directory(Paths.cache, 'happy-media', refKey);
    directory.create({ intermediates: true, idempotent: true });
    const file = new File(directory, name.replace(/[/\\]/g, '_') || 'attachment');
    if (!file.exists || file.size !== bytes.length) {
        file.write(bytes);
    }
    return file.uri;
}

/** Open the system share sheet, which offers Save to Photos/Files on both platforms. */
export async function saveAttachmentFile(uri: string, name: string, mimeType: string): Promise<void> {
    if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device');
    }
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: name });
}
