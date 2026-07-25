/**
 * Client for the local Happy daemon's control server + persisted state.
 *
 * Key resolution for sessions (contract): (1) POST /list on the daemon's
 * localhost control server — newer daemons attach
 * `encryption: { key /* base64 *\/, variant }` per child — (2) fall back to
 * the persisted `$HAPPY_HOME_DIR/sessions.json` (the RUNNING daemon may be
 * old code without the encryption field). Both sources are merged; /list
 * wins. Port comes from `$HAPPY_HOME_DIR/daemon.state.json` (httpPort).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionKeyInfo } from './types';

export interface DaemonChildInfo {
  sessionId: string;
  pid: number;
  startedBy: string;
  agent?: string;
  path?: string;
  encryption?: { key: string /* base64 */; variant: 'legacy' | 'dataKey' };
}

export interface ResolvedSessionKeys {
  keys: Map<string, SessionKeyInfo>;
  /** Session ids reported by the local daemon /list (SessionView.local). */
  local: Set<string>;
  children: DaemonChildInfo[];
}

/** Mirrors readPersistedSessions in happy-cli: entries older than this are dropped. */
const PERSISTED_SESSION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readVariant(value: unknown): 'legacy' | 'dataKey' | null {
  return value === 'legacy' || value === 'dataKey' ? value : null;
}

/** Read the daemon control-server port from daemon.state.json; null when absent/malformed. */
export async function readDaemonPort(homeDir: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(homeDir, 'daemon.state.json'), 'utf8'));
    if (isRecord(parsed) && typeof parsed.httpPort === 'number' && parsed.httpPort > 0) {
      return parsed.httpPort;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /list on the daemon control server.
 * Tolerates older daemons (no encryption field) and any failure → [].
 */
export async function listDaemonSessions(port: number): Promise<DaemonChildInfo[]> {
  let body: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return [];
    }
    body = await response.json();
  } catch {
    return [];
  }

  if (!isRecord(body) || !Array.isArray(body.children)) {
    return [];
  }

  const children: DaemonChildInfo[] = [];
  for (const child of body.children) {
    if (!isRecord(child) || typeof child.happySessionId !== 'string' || typeof child.pid !== 'number') {
      continue;
    }
    const info: DaemonChildInfo = {
      sessionId: child.happySessionId,
      pid: child.pid,
      startedBy: typeof child.startedBy === 'string' ? child.startedBy : 'unknown',
    };
    if (typeof child.agent === 'string') info.agent = child.agent;
    if (typeof child.path === 'string') info.path = child.path;
    const variant = isRecord(child.encryption) ? readVariant(child.encryption.variant) : null;
    if (isRecord(child.encryption) && typeof child.encryption.key === 'string' && variant !== null) {
      info.encryption = { key: child.encryption.key, variant };
    }
    children.push(info);
  }
  return children;
}

/** Stop one daemon-tracked session by its exact Happy session id. */
export async function stopDaemonSession(port: number, sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stop-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return isRecord(body) && body.success === true;
  } catch {
    return false;
  }
}

/**
 * Parse `$HAPPY_HOME_DIR/sessions.json`:
 * { sessions: { <id>: { encryptionKey, encryptionVariant, ..., savedAt } } }.
 * Entries older than 14 days (by savedAt) are dropped, mirroring the CLI's
 * readPersistedSessions. Missing file / malformed entries are tolerated.
 */
export async function readPersistedSessionKeys(homeDir: string, now: number = Date.now()): Promise<Map<string, SessionKeyInfo>> {
  const keys = new Map<string, SessionKeyInfo>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(homeDir, 'sessions.json'), 'utf8'));
  } catch {
    return keys;
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
    return keys;
  }
  for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
    if (!isRecord(entry) || typeof entry.encryptionKey !== 'string' || entry.encryptionKey.length === 0) {
      continue;
    }
    const variant = readVariant(entry.encryptionVariant);
    if (variant === null) {
      continue;
    }
    if (typeof entry.savedAt === 'number' && now - entry.savedAt > PERSISTED_SESSION_MAX_AGE_MS) {
      continue;
    }
    keys.set(sessionId, { sessionId, encryptionKey: entry.encryptionKey, encryptionVariant: variant });
  }
  return keys;
}

/**
 * Merge key sources: daemon /list encryption (preferred) over sessions.json.
 * Never throws — a missing/unreachable/old daemon just yields the file fallback.
 */
export async function resolveSessionKeys(
  homeDir: string,
  port: number | null,
  now: number = Date.now(),
): Promise<ResolvedSessionKeys> {
  const [persisted, children] = await Promise.all([
    readPersistedSessionKeys(homeDir, now),
    port !== null ? listDaemonSessions(port) : Promise.resolve([] as DaemonChildInfo[]),
  ]);

  const keys = new Map<string, SessionKeyInfo>(persisted);
  const local = new Set<string>();
  for (const child of children) {
    local.add(child.sessionId);
    if (child.encryption) {
      keys.set(child.sessionId, {
        sessionId: child.sessionId,
        encryptionKey: child.encryption.key,
        encryptionVariant: child.encryption.variant,
      });
    }
  }
  return { keys, local, children };
}
