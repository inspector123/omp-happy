import { createHash, randomUUID, type Hash } from 'crypto';
import { open, link, stat, unlink, type FileHandle } from 'fs/promises';
import { basename, extname, join } from 'path';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { validatePath } from './pathSecurity';

const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FILENAME_ATTEMPTS = 10_000;

type StartFileUploadRequest = {
    name: string;
    size: number;
};

type StartFileUploadResponse = {
    success: boolean;
    uploadId?: string;
    path?: string;
    error?: string;
};

type AppendFileUploadRequest = {
    uploadId: string;
    offset: number;
    content: string;
};

type FileUploadResponse = {
    success: boolean;
    received?: number;
    path?: string;
    hash?: string;
    error?: string;
};

type FileUploadState = {
    destinationPath: string;
    relativePath: string;
    temporaryPath: string;
    expectedSize: number;
    received: number;
    handle: FileHandle;
    hash: Hash;
    timeout: ReturnType<typeof setTimeout> | undefined;
};

function safeFileName(name: string): string | null {
    const normalized = name.replace(/\\/g, '/');
    const fileName = basename(normalized).trim().replaceAll('\0', '');
    return fileName && fileName !== '.' && fileName !== '..' ? fileName : null;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

function numberedFileName(fileName: string, attempt: number): string {
    if (attempt === 0) return fileName;
    const extension = extname(fileName);
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    return `${stem} (${attempt})${extension}`;
}

/** Registers the chunked RPC path used to copy phone files into a session workspace. */
export function registerFileUploadHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    const uploads = new Map<string, FileUploadState>();
    const reservedDestinations = new Set<string>();

    const removeUpload = async (uploadId: string): Promise<void> => {
        const upload = uploads.get(uploadId);
        if (!upload) return;
        uploads.delete(uploadId);
        reservedDestinations.delete(upload.destinationPath);
        clearTimeout(upload.timeout);
        try {
            await upload.handle.close();
        } catch {
            // The handle may already be closed by the finish path.
        }
        await unlink(upload.temporaryPath).catch(() => undefined);
    };

    const armTimeout = (uploadId: string, upload: FileUploadState): void => {
        clearTimeout(upload.timeout);
        upload.timeout = setTimeout(() => {
            void removeUpload(uploadId);
        }, UPLOAD_IDLE_TIMEOUT_MS);
    };

    rpcHandlerManager.registerHandler<StartFileUploadRequest, StartFileUploadResponse>('startFileUpload', async (data) => {
        const fileName = typeof data.name === 'string' ? safeFileName(data.name) : null;
        if (!fileName) return { success: false, error: 'A valid file name is required' };
        if (!Number.isSafeInteger(data.size) || data.size < 0) {
            return { success: false, error: 'A valid file size is required' };
        }

        try {
            for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
                const relativePath = numberedFileName(fileName, attempt);
                const validation = validatePath(relativePath, workingDirectory);
                if (!validation.valid || !validation.resolvedPath) {
                    return { success: false, error: validation.error ?? 'Invalid destination path' };
                }
                const destinationPath = validation.resolvedPath;
                if (reservedDestinations.has(destinationPath) || await fileExists(destinationPath)) continue;

                const uploadId = randomUUID();
                const temporaryPath = join(workingDirectory, `.${relativePath}.happy-upload-${uploadId}`);
                const handle = await open(temporaryPath, 'wx');
                const placeholderTimeout = undefined;
                const upload: FileUploadState = {
                    destinationPath,
                    relativePath,
                    temporaryPath,
                    expectedSize: data.size,
                    received: 0,
                    handle,
                    hash: createHash('sha256'),
                    timeout: placeholderTimeout,
                };
                uploads.set(uploadId, upload);
                reservedDestinations.add(destinationPath);
                armTimeout(uploadId, upload);
                return { success: true, uploadId, path: relativePath };
            }
            return { success: false, error: 'Could not choose an available destination file name' };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to start file upload' };
        }
    });

    rpcHandlerManager.registerHandler<AppendFileUploadRequest, FileUploadResponse>('appendFileUpload', async (data) => {
        const upload = uploads.get(data.uploadId);
        if (!upload) return { success: false, error: 'File upload is no longer active' };
        if (data.offset !== upload.received) {
            return { success: false, error: `Unexpected upload offset ${data.offset}; expected ${upload.received}` };
        }

        try {
            const chunk = Buffer.from(data.content, 'base64');
            if (chunk.length === 0 && upload.received < upload.expectedSize) {
                return { success: false, error: 'Received an empty file chunk' };
            }
            if (upload.received + chunk.length > upload.expectedSize) {
                return { success: false, error: 'File upload exceeded its declared size' };
            }

            let written = 0;
            while (written < chunk.length) {
                const result = await upload.handle.write(
                    chunk,
                    written,
                    chunk.length - written,
                    upload.received + written,
                );
                if (result.bytesWritten === 0) throw new Error('Could not write file chunk');
                written += result.bytesWritten;
            }
            upload.hash.update(chunk);
            upload.received += chunk.length;
            armTimeout(data.uploadId, upload);
            return { success: true, received: upload.received };
        } catch (error) {
            await removeUpload(data.uploadId);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file chunk' };
        }
    });

    rpcHandlerManager.registerHandler<{ uploadId: string }, FileUploadResponse>('finishFileUpload', async (data) => {
        const upload = uploads.get(data.uploadId);
        if (!upload) return { success: false, error: 'File upload is no longer active' };
        if (upload.received !== upload.expectedSize) {
            await removeUpload(data.uploadId);
            return { success: false, error: `File upload is incomplete (${upload.received}/${upload.expectedSize} bytes)` };
        }

        uploads.delete(data.uploadId);
        reservedDestinations.delete(upload.destinationPath);
        clearTimeout(upload.timeout);
        try {
            await upload.handle.sync();
            await upload.handle.close();
            await link(upload.temporaryPath, upload.destinationPath);
            await unlink(upload.temporaryPath);
            return {
                success: true,
                path: upload.relativePath,
                hash: upload.hash.digest('hex'),
            };
        } catch (error) {
            try {
                await upload.handle.close();
            } catch {
                // The handle may already be closed.
            }
            await unlink(upload.temporaryPath).catch(() => undefined);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to finish file upload' };
        }
    });

    rpcHandlerManager.registerHandler<{ uploadId: string }, FileUploadResponse>('cancelFileUpload', async (data) => {
        await removeUpload(data.uploadId);
        return { success: true };
    });
}
