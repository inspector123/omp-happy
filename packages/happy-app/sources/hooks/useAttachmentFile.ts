/**
 * Decrypts a chat attachment into a playable/shareable URI (cache file on
 * native, object URL on web). URIs are kept per ref for the app's lifetime so
 * scrolling back or saving after playback never re-downloads; concurrent
 * requests for one ref share a single download.
 */
import * as React from 'react';
import { loadAttachmentBytes } from '@/hooks/useAttachmentImage';
import { writeAttachmentFile } from '@/utils/attachmentFile';

const fileUris = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

export function ensureAttachmentFile(sessionId: string, ref: string, name: string, mimeType: string): Promise<string> {
    const cached = fileUris.get(ref);
    if (cached) return Promise.resolve(cached);
    let promise = inFlight.get(ref);
    if (!promise) {
        promise = (async () => {
            const bytes = await loadAttachmentBytes(sessionId, ref);
            if (!bytes) throw new Error('Could not download or decrypt the attachment');
            const uri = await writeAttachmentFile(ref, bytes, name, mimeType);
            fileUris.set(ref, uri);
            return uri;
        })().finally(() => { inFlight.delete(ref); });
        inFlight.set(ref, promise);
    }
    return promise;
}

export type AttachmentFileState = {
    uri: string | null;
    error: string | null;
};

export function useAttachmentFile(sessionId: string | undefined, ref: string, name: string, mimeType: string): AttachmentFileState {
    const [state, setState] = React.useState<AttachmentFileState>(() => ({ uri: fileUris.get(ref) ?? null, error: null }));

    React.useEffect(() => {
        if (!sessionId) return;
        const cached = fileUris.get(ref);
        if (cached) {
            setState({ uri: cached, error: null });
            return;
        }
        let cancelled = false;
        setState({ uri: null, error: null });
        ensureAttachmentFile(sessionId, ref, name, mimeType).then(
            (uri) => { if (!cancelled) setState({ uri, error: null }); },
            (error) => { if (!cancelled) setState({ uri: null, error: error instanceof Error ? error.message : String(error) }); },
        );
        return () => { cancelled = true; };
    }, [sessionId, ref, name, mimeType]);

    return state;
}
