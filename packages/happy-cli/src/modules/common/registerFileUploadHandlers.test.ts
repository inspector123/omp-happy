import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../api/encryption';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { registerFileUploadHandlers } from './registerFileUploadHandlers';

const encryptionKey = new Uint8Array(32).fill(7);
const temporaryDirectories: string[] = [];

async function createHarness() {
    const directory = await mkdtemp(join(tmpdir(), 'happy-file-upload-'));
    temporaryDirectories.push(directory);
    const manager = new RpcHandlerManager({
        scopePrefix: 'session',
        encryptionKey,
        encryptionVariant: 'legacy',
        logger: () => undefined,
    });
    registerFileUploadHandlers(manager, directory);

    const call = async <T>(method: string, params: unknown): Promise<T> => {
        const response = await manager.handleRequest({
            method: `session:${method}`,
            params: encodeBase64(encrypt(encryptionKey, 'legacy', params)),
        });
        return decrypt(encryptionKey, 'legacy', decodeBase64(response)) as T;
    };
    return { directory, call };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('workspace file upload RPC', () => {
    it('assembles chunks into a plaintext file without replacing an existing file', async () => {
        const { directory, call } = await createHarness();
        await writeFile(join(directory, 'report.txt'), 'existing');

        const start = await call<{ success: boolean; uploadId: string; path: string }>('startFileUpload', {
            name: '../report.txt',
            size: 11,
        });
        expect(start).toMatchObject({ success: true, path: 'report (1).txt' });

        await expect(call('appendFileUpload', {
            uploadId: start.uploadId,
            offset: 0,
            content: Buffer.from('hello ').toString('base64'),
        })).resolves.toMatchObject({ success: true, received: 6 });
        await expect(call('appendFileUpload', {
            uploadId: start.uploadId,
            offset: 6,
            content: Buffer.from('world').toString('base64'),
        })).resolves.toMatchObject({ success: true, received: 11 });
        await expect(call('finishFileUpload', { uploadId: start.uploadId })).resolves.toMatchObject({
            success: true,
            path: 'report (1).txt',
        });

        await expect(readFile(join(directory, 'report.txt'), 'utf8')).resolves.toBe('existing');
        await expect(readFile(join(directory, 'report (1).txt'), 'utf8')).resolves.toBe('hello world');
        expect((await readdir(directory)).filter((name) => name.includes('.happy-upload-'))).toEqual([]);
    });
});
