/**
 * Message encryption for the happy-desktop sync core.
 *
 * Ported VERBATIM (algorithm and wire format) from
 * packages/happy-cli/src/api/encryption.ts — the only change is that the
 * legacy NaCl secretbox path uses libsodium-wrappers (already a declared
 * dependency of this package) instead of tweetnacl. Both implement
 * XSalsa20-Poly1305 with an identical wire format
 * ([nonce (24)] [MAC (16) || ciphertext]), so ciphertext is interchangeable;
 * encryption.test.ts proves both directions against the happy-cli code path.
 *
 * dataKey variant: AES-256-GCM via node:crypto, bundle layout
 * [version=0 (1)] [nonce (12)] [ciphertext] [auth tag (16)].
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import type { EncryptionVariant } from './types';

let sodiumReady: Promise<void> | null = null;

function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    sodiumReady = sodium.ready.then(() => undefined);
  }
  return sodiumReady;
}

export function encodeBase64(buffer: Uint8Array, variant: 'base64' | 'base64url' = 'base64'): string {
  if (variant === 'base64url') {
    return Buffer.from(buffer)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  }
  return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(base64: string, variant: 'base64' | 'base64url' = 'base64'): Uint8Array {
  if (variant === 'base64url') {
    const base64Standard = base64
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      + '='.repeat((4 - base64.length % 4) % 4);
    return new Uint8Array(Buffer.from(base64Standard, 'base64'));
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function getRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

/**
 * Encrypt data using the secret key (NaCl secretbox, XSalsa20-Poly1305).
 * Wire format: [nonce (24 bytes)] [encrypted data]
 */
export async function encryptLegacy(data: unknown, secret: Uint8Array): Promise<Uint8Array> {
  await ensureSodium();
  const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = sodium.crypto_secretbox_easy(plaintext, nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

/**
 * Decrypt data using the secret key. Returns null on failure.
 */
export async function decryptLegacy(data: Uint8Array, secret: Uint8Array): Promise<unknown | null> {
  await ensureSodium();
  if (data.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
    return null;
  }
  const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = data.slice(sodium.crypto_secretbox_NONCEBYTES);
  try {
    const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, secret);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

/**
 * Encrypt data using AES-256-GCM with the data encryption key.
 * Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
 */
export async function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Promise<Uint8Array> {
  const nonce = getRandomBytes(12); // GCM uses 12-byte nonces
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);

  return bundle;
}

/**
 * Decrypt data using AES-256-GCM with the data encryption key.
 * Returns null on failure.
 */
export async function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): Promise<unknown | null> {
  if (bundle.length < 1) {
    return null;
  }
  if (bundle[0] !== 0) { // Only version 0
    return null;
  }
  if (bundle.length < 12 + 16 + 1) { // Minimum: version + nonce + auth tag
    return null;
  }

  const nonce = bundle.slice(1, 13);
  const authTag = bundle.slice(bundle.length - 16);
  const ciphertext = bundle.slice(13, bundle.length - 16);

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

export async function encrypt(key: Uint8Array, variant: EncryptionVariant, data: unknown): Promise<Uint8Array> {
  if (variant === 'legacy') {
    return encryptLegacy(data, key);
  }
  return encryptWithDataKey(data, key);
}

export async function decrypt(key: Uint8Array, variant: EncryptionVariant, data: Uint8Array): Promise<unknown | null> {
  if (variant === 'legacy') {
    return decryptLegacy(data, key);
  }
  return decryptWithDataKey(data, key);
}
