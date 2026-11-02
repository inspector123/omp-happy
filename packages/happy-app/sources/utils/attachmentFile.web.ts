/**
 * Web impl: decrypted attachments become object URLs that <video> can play and
 * an <a download> can save. Native counterpart: attachmentFile.ts.
 */

export async function writeAttachmentFile(_ref: string, bytes: Uint8Array, _name: string, mimeType: string): Promise<string> {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
}

export async function saveAttachmentFile(uri: string, name: string, _mimeType: string): Promise<void> {
    const anchor = document.createElement('a');
    anchor.href = uri;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}
