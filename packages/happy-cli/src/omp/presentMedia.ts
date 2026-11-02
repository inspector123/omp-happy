import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { ATTACHMENT_MAX_PLAINTEXT_BYTES } from '@/api/apiSession';

export type PresentedMediaKind = 'image' | 'video';

export type PresentedMedia = {
  path: string;
  name: string;
  mimeType: string;
  kind: PresentedMediaKind;
  size: number;
  ref: string;
};

export type PresentMediaFailure = {
  path: string;
  error: string;
};

export type PresentMediaResult = {
  media: PresentedMedia[];
  errors: PresentMediaFailure[];
};

// Formats the companion app can render: expo-image decodes these images on
// iOS, Android, and web, and expo-video plays these containers natively.
const MEDIA_TYPES: Record<string, { mimeType: string; kind: PresentedMediaKind }> = {
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.gif': { mimeType: 'image/gif', kind: 'image' },
  '.webp': { mimeType: 'image/webp', kind: 'image' },
  '.bmp': { mimeType: 'image/bmp', kind: 'image' },
  '.mp4': { mimeType: 'video/mp4', kind: 'video' },
  '.m4v': { mimeType: 'video/mp4', kind: 'video' },
  '.mov': { mimeType: 'video/quicktime', kind: 'video' },
  '.webm': { mimeType: 'video/webm', kind: 'video' },
};

/**
 * Upload each absolute path as an encrypted session attachment. Every path is
 * attempted independently so one bad file does not hide the others.
 */
export async function presentMediaFiles(
  paths: readonly string[],
  upload: (data: Uint8Array, name: string) => Promise<string>,
): Promise<PresentMediaResult> {
  const media: PresentedMedia[] = [];
  const errors: PresentMediaFailure[] = [];
  for (const path of paths) {
    const type = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!type) {
      errors.push({
        path,
        error: `Unsupported file type "${extname(path) || '(none)'}". Supported: ${Object.keys(MEDIA_TYPES).join(' ')}`,
      });
      continue;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        errors.push({ path, error: 'Not a regular file' });
        continue;
      }
      if (info.size === 0) {
        errors.push({ path, error: 'File is empty' });
        continue;
      }
      if (info.size > ATTACHMENT_MAX_PLAINTEXT_BYTES) {
        const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        errors.push({
          path,
          error: `File is ${megabytes(info.size)}, over the ${megabytes(ATTACHMENT_MAX_PLAINTEXT_BYTES)} attachment limit`,
        });
        continue;
      }
      const data = new Uint8Array(await readFile(path));
      const name = basename(path);
      const ref = await upload(data, name);
      media.push({ path, name, mimeType: type.mimeType, kind: type.kind, size: data.length, ref });
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { media, errors };
}
