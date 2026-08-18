import { useCallback, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';
import { encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import {
    sessionAppendFileUpload,
    sessionCancelFileUpload,
    sessionFinishFileUpload,
    sessionStartFileUpload,
} from '@/sync/ops';
import { t } from '@/text';

export const FILE_UPLOAD_CHUNK_SIZE = 256 * 1024;

async function readChunk(asset: DocumentPicker.DocumentPickerAsset, offset: number, length: number): Promise<string> {
    if (asset.file) {
        const bytes = new Uint8Array(await asset.file.slice(offset, offset + length).arrayBuffer());
        return encodeBase64(bytes);
    }
    return readAsStringAsync(asset.uri, {
        encoding: EncodingType.Base64,
        position: offset,
        length,
    });
}

/** Copies one picked file into the computer's session workspace without using attachment storage. */
export async function uploadPickedFile(sessionId: string, asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
    const size = asset.file?.size ?? asset.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
        throw new Error('The selected file size is unavailable');
    }

    const start = await sessionStartFileUpload(sessionId, asset.name, size);
    if (!start.success || !start.uploadId || !start.path) {
        throw new Error(start.error ?? 'The computer could not start the file upload');
    }

    try {
        let offset = 0;
        while (offset < size) {
            const length = Math.min(FILE_UPLOAD_CHUNK_SIZE, size - offset);
            const content = await readChunk(asset, offset, length);
            const append = await sessionAppendFileUpload(sessionId, start.uploadId, offset, content);
            const expectedReceived = offset + length;
            if (!append.success || append.received !== expectedReceived) {
                throw new Error(append.error ?? 'The computer rejected a file chunk');
            }
            offset = expectedReceived;
        }

        const finish = await sessionFinishFileUpload(sessionId, start.uploadId);
        if (!finish.success || !finish.path) {
            throw new Error(finish.error ?? 'The computer could not finish the file upload');
        }
        return finish.path;
    } catch (error) {
        await sessionCancelFileUpload(sessionId, start.uploadId);
        throw error;
    }
}

export function useFileUpload(sessionId: string) {
    const [isUploadingFile, setIsUploadingFile] = useState(false);
    const uploadInFlight = useRef(false);

    const pickAndUploadFiles = useCallback(async () => {
        if (uploadInFlight.current) return;
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            copyToCacheDirectory: true,
            base64: false,
        });
        if (result.canceled || result.assets.length === 0) return;

        uploadInFlight.current = true;
        setIsUploadingFile(true);
        const uploadedPaths: string[] = [];
        const failures: string[] = [];
        try {
            for (const asset of result.assets) {
                try {
                    uploadedPaths.push(await uploadPickedFile(sessionId, asset));
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    failures.push(`${asset.name}: ${message}`);
                }
            }
        } finally {
            uploadInFlight.current = false;
            setIsUploadingFile(false);
        }

        const uploaded = uploadedPaths.map((path) => `./${path}`);
        if (failures.length > 0) {
            Modal.alert(t('common.error'), [...uploaded, ...failures].join('\n'));
        } else {
            Modal.alert(t('common.success'), uploaded.join('\n'));
        }
    }, [sessionId]);

    return { pickAndUploadFiles, isUploadingFile };
}
