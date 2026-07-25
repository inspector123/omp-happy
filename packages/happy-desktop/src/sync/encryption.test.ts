import { describe, it, expect } from 'vitest';
import { getRandomBytes } from '../../../happy-cli/src/api/encryption';
import {
  encryptLegacy as cliEncryptLegacy,
  decryptLegacy as cliDecryptLegacy,
  encryptWithDataKey as cliEncryptWithDataKey,
  decryptWithDataKey as cliDecryptWithDataKey,
  encodeBase64 as cliEncodeBase64,
  decodeBase64 as cliDecodeBase64,
} from '../../../happy-cli/src/api/encryption';
import {
  encrypt,
  decrypt,
  encodeBase64,
  decodeBase64,
} from './encryption';

const DATA_KEY = getRandomBytes(32);
const LEGACY_SECRET = getRandomBytes(32);

const PAYLOADS: unknown[] = [
  { hello: 'world' },
  { role: 'user', content: { type: 'text', text: 'Reply with exactly: DESKTOP-E2E-OK' }, meta: { sentFrom: 'web' } },
  { nested: { arr: [1, 2, 3], unicode: 'héllo ✓ 中文' }, n: 0, b: false, nil: null },
  'plain string',
  [],
];

describe('encryption (desktop port)', () => {
  describe('base64 helpers', () => {
    it('round-trips and matches happy-cli encoding', () => {
      const bytes = getRandomBytes(64);
      const mine = encodeBase64(bytes);
      const theirs = cliEncodeBase64(bytes);
      expect(mine).toBe(theirs);
      expect(new Uint8Array(decodeBase64(mine))).toEqual(bytes);
      expect(new Uint8Array(cliDecodeBase64(mine))).toEqual(bytes);
    });

    it('decodes base64url variant', () => {
      const bytes = getRandomBytes(33);
      const b64url = Buffer.from(bytes).toString('base64')
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      expect(new Uint8Array(decodeBase64(b64url, 'base64url'))).toEqual(bytes);
    });
  });

  describe('dataKey (AES-256-GCM) variant', () => {
    it('round-trips arbitrary JSON payloads', async () => {
      for (const payload of PAYLOADS) {
        const encrypted = await encrypt(DATA_KEY, 'dataKey', payload);
        const decrypted = await decrypt(DATA_KEY, 'dataKey', encrypted);
        expect(decrypted).toEqual(payload);
      }
    });

    it('decrypts fixtures produced by happy-cli encryptWithDataKey', async () => {
      // Fixture generated with the exact happy-cli code path.
      for (const payload of PAYLOADS) {
        const fixture = cliEncryptWithDataKey(payload, DATA_KEY);
        expect(await decrypt(DATA_KEY, 'dataKey', fixture)).toEqual(payload);
      }
    });

    it('produces ciphertext happy-cli decryptWithDataKey can read', async () => {
      for (const payload of PAYLOADS) {
        const encrypted = await encrypt(DATA_KEY, 'dataKey', payload);
        expect(cliDecryptWithDataKey(encrypted, DATA_KEY)).toEqual(payload);
      }
    });

    it('returns null for wrong key, bad version byte, and truncated bundles', async () => {
      const encrypted = await encrypt(DATA_KEY, 'dataKey', { a: 1 });
      expect(await decrypt(getRandomBytes(32), 'dataKey', encrypted)).toBeNull();

      const badVersion = new Uint8Array(encrypted);
      badVersion[0] = 1;
      expect(await decrypt(DATA_KEY, 'dataKey', badVersion)).toBeNull();

      expect(await decrypt(DATA_KEY, 'dataKey', encrypted.slice(0, 10))).toBeNull();
      expect(await decrypt(DATA_KEY, 'dataKey', new Uint8Array(0))).toBeNull();

      const tampered = new Uint8Array(encrypted);
      tampered[20] = tampered[20] ^ 0xff;
      expect(await decrypt(DATA_KEY, 'dataKey', tampered)).toBeNull();
    });
  });

  describe('legacy (NaCl secretbox) variant', () => {
    it('round-trips arbitrary JSON payloads', async () => {
      for (const payload of PAYLOADS) {
        const encrypted = await encrypt(LEGACY_SECRET, 'legacy', payload);
        const decrypted = await decrypt(LEGACY_SECRET, 'legacy', encrypted);
        expect(decrypted).toEqual(payload);
      }
    });

    it('decrypts fixtures produced by happy-cli encryptLegacy (tweetnacl)', async () => {
      // Wire-format compatibility: libsodium crypto_secretbox_easy must read
      // tweetnacl secretbox output byte-for-byte (XSalsa20-Poly1305).
      for (const payload of PAYLOADS) {
        const fixture = cliEncryptLegacy(payload, LEGACY_SECRET);
        expect(await decrypt(LEGACY_SECRET, 'legacy', fixture)).toEqual(payload);
      }
    });

    it('produces ciphertext happy-cli decryptLegacy (tweetnacl) can read', async () => {
      for (const payload of PAYLOADS) {
        const encrypted = await encrypt(LEGACY_SECRET, 'legacy', payload);
        expect(cliDecryptLegacy(encrypted, LEGACY_SECRET)).toEqual(payload);
      }
    });

    it('returns null for wrong key or truncated bundles', async () => {
      const encrypted = await encrypt(LEGACY_SECRET, 'legacy', { a: 1 });
      expect(await decrypt(getRandomBytes(32), 'legacy', encrypted)).toBeNull();
      expect(await decrypt(LEGACY_SECRET, 'legacy', encrypted.slice(0, 8))).toBeNull();
    });
  });
});
