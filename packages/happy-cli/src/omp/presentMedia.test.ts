import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ATTACHMENT_MAX_PLAINTEXT_BYTES } from '@/api/apiSession';
import { presentMediaFiles } from './presentMedia';

describe('presentMediaFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'present-media-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads supported images and videos with their bytes, names, and MIME types', async () => {
    const image = join(dir, 'Chart.PNG');
    const video = join(dir, 'clip.mov');
    await writeFile(image, Buffer.from([1, 2, 3]));
    await writeFile(video, Buffer.from([4, 5]));
    const upload = vi.fn(async (_data: Uint8Array, name: string) => `sessions/s/attachments/${name}.enc`);

    const result = await presentMediaFiles([image, video], upload);

    expect(upload.mock.calls.map(([data, name]) => [Array.from(data), name])).toEqual([
      [[1, 2, 3], 'Chart.PNG'],
      [[4, 5], 'clip.mov'],
    ]);
    expect(result).toEqual({
      media: [
        { path: image, name: 'Chart.PNG', mimeType: 'image/png', kind: 'image', size: 3, ref: 'sessions/s/attachments/Chart.PNG.enc' },
        { path: video, name: 'clip.mov', mimeType: 'video/quicktime', kind: 'video', size: 2, ref: 'sessions/s/attachments/clip.mov.enc' },
      ],
      errors: [],
    });
  });

  it('reports each unusable path without uploading it or blocking the others', async () => {
    const good = join(dir, 'ok.webp');
    const text = join(dir, 'notes.txt');
    const folder = join(dir, 'frames.png');
    const empty = join(dir, 'empty.gif');
    await writeFile(good, Buffer.from([9]));
    await writeFile(text, 'hello');
    await mkdir(folder);
    await writeFile(empty, '');
    const upload = vi.fn(async () => 'ref');

    const result = await presentMediaFiles([text, join(dir, 'missing.mp4'), folder, empty, good], upload);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.media.map((item) => item.name)).toEqual(['ok.webp']);
    expect(result.errors.map((failure) => failure.path)).toEqual([text, join(dir, 'missing.mp4'), folder, empty]);
    expect(result.errors[0].error).toContain('Unsupported file type ".txt"');
    expect(result.errors[1].error).toContain('ENOENT');
    expect(result.errors[2].error).toBe('Not a regular file');
    expect(result.errors[3].error).toBe('File is empty');
  });

  it('accepts a file at the attachment limit and rejects one byte over it', async () => {
    const atLimit = join(dir, 'at.mp4');
    const overLimit = join(dir, 'over.mp4');
    await writeFile(atLimit, '');
    await writeFile(overLimit, '');
    await truncate(atLimit, ATTACHMENT_MAX_PLAINTEXT_BYTES);
    await truncate(overLimit, ATTACHMENT_MAX_PLAINTEXT_BYTES + 1);
    const upload = vi.fn(async () => 'ref');

    const result = await presentMediaFiles([atLimit, overLimit], upload);

    expect(result.media.map((item) => [item.name, item.size])).toEqual([['at.mp4', ATTACHMENT_MAX_PLAINTEXT_BYTES]]);
    expect(result.errors).toEqual([{ path: overLimit, error: 'File is 50.0 MB, over the 50.0 MB attachment limit' }]);
  });

  it('reports upload failures per file', async () => {
    const image = join(dir, 'a.jpg');
    await writeFile(image, Buffer.from([1]));

    const result = await presentMediaFiles([image], async () => {
      throw new Error('request-upload returned 413');
    });

    expect(result).toEqual({ media: [], errors: [{ path: image, error: 'request-upload returned 413' }] });
  });
});
