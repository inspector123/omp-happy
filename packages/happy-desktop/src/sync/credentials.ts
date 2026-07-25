/**
 * Credential loading for the desktop sync core.
 * Reads the local Happy CLI credentials ($HAPPY_HOME_DIR/access.key,
 * default ~/.omp-happy) — same files parsed by packages/happy-cli/src/persistence.ts
 * readCredentials(). The `token` authenticates user-scoped REST + socket.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Credentials, EncryptionVariant } from './types';

export type CredentialEncryption =
  | { type: 'legacy'; secret: Uint8Array }
  | { type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array };

export interface LoadedCredentials extends Credentials {
  encryption: CredentialEncryption;
}

export function defaultHappyHomeDir(): string {
  return process.env.HAPPY_HOME_DIR || join(homedir(), '.omp-happy');
}

function decode(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`access.key: ${name} is missing or not a string`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Load full credentials (token + encryption material) from access.key. */
export async function loadCredentials(homeDir: string = defaultHappyHomeDir()): Promise<LoadedCredentials> {
  const file = join(homeDir, 'access.key');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read credentials from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
    throw new Error(`access.key at ${file} has no token`);
  }

  let encryption: CredentialEncryption;
  if (typeof parsed.secret === 'string' && parsed.secret.length > 0) {
    encryption = { type: 'legacy', secret: decode(parsed.secret, 'secret') };
  } else if (parsed.encryption && typeof parsed.encryption === 'object') {
    const enc = parsed.encryption as Record<string, unknown>;
    encryption = {
      type: 'dataKey',
      publicKey: decode(enc.publicKey, 'encryption.publicKey'),
      machineKey: decode(enc.machineKey, 'encryption.machineKey'),
    };
  } else {
    throw new Error(`access.key at ${file} has neither secret nor encryption material`);
  }

  return { token: parsed.token, homeDir, encryption };
}

/** The machine RPC key: machineKey (dataKey creds) or master secret (legacy creds). */
export function machineRpcKey(credentials: LoadedCredentials): { key: Uint8Array; variant: EncryptionVariant } {
  return credentials.encryption.type === 'dataKey'
    ? { key: credentials.encryption.machineKey, variant: 'dataKey' }
    : { key: credentials.encryption.secret, variant: 'legacy' };
}

/** Read the machineId written to settings.json during CLI auth (authAndSetupMachineIfNeeded). */
export async function readMachineId(homeDir: string = defaultHappyHomeDir()): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8'));
    return typeof parsed.machineId === 'string' && parsed.machineId.length > 0 ? parsed.machineId : null;
  } catch {
    return null;
  }
}
