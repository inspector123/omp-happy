import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../../api/encryption';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { registerFileUploadHandlers, UPLOADS_DIRECTORY } from './registerFileUploadHandlers';

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
    it('assembles chunks into the uploads folder without replacing an existing file', async () => {
        const { directory, call } = await createHarness();
        const uploadsDirectory = join(directory, UPLOADS_DIRECTORY);
        await mkdir(uploadsDirectory);
        await writeFile(join(uploadsDirectory, 'report.txt'), 'existing');

        const start = await call<{ success: boolean; uploadId: string; path: string }>('startFileUpload', {
            name: '../report.txt',
            size: 11,
        });
        expect(start).toMatchObject({ success: true, path: `${UPLOADS_DIRECTORY}/report (1).txt` });

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
            path: `${UPLOADS_DIRECTORY}/report (1).txt`,
        });

        await expect(readFile(join(uploadsDirectory, 'report.txt'), 'utf8')).resolves.toBe('existing');
        await expect(readFile(join(directory, start.path), 'utf8')).resolves.toBe('hello world');
        expect((await readdir(uploadsDirectory)).filter((name) => name.includes('.happy-upload-'))).toEqual([]);
    });

    it('keeps uploads out of git in a repository working directory', async () => {
        const { directory, call } = await createHarness();
        execFileSync('git', ['init', '-q'], { cwd: directory });

        const start = await call<{ success: boolean; uploadId: string; path: string }>('startFileUpload', {
            name: 'photo.jpg',
            size: 3,
        });
        await call('appendFileUpload', { uploadId: start.uploadId, offset: 0, content: Buffer.from('jpg').toString('base64') });
        await expect(call('finishFileUpload', { uploadId: start.uploadId })).resolves.toMatchObject({
            success: true,
            path: `${UPLOADS_DIRECTORY}/photo.jpg`,
        });

        const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: directory, encoding: 'utf8' });
        expect(status).toBe('');
    });
});
