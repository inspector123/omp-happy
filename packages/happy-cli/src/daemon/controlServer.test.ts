/**
 * Unit tests for the daemon control server /list endpoint.
 *
 * Covers the encryption material exposure used by the desktop client:
 * - tracked session with in-memory encryption -> /list includes { key, variant }
 * - tracked session without any encryption -> field absent
 * - tracked session without in-memory encryption -> fallback to persisted sessions.json entry
 * - in-memory encryption wins over the persisted entry for the same session
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';
import { encodeBase64 } from '@/api/encryption';
import { readPersistedSessions } from '@/persistence';
import type { PersistedSession } from '@/persistence';
import type { Metadata } from '@/api/types';
import type { ListedDaemonSession, TrackedSession } from './types';

vi.mock('@/persistence', () => ({
  readPersistedSessions: vi.fn(() => ({})),
}));

const mockedReadPersistedSessions = vi.mocked(readPersistedSessions);

const PERSISTED_SESSION_ID = 'persisted-fallback-session';
const PERSISTED_KEY_BASE64 = encodeBase64(new Uint8Array(32).fill(7));

/** Mirrors the on-disk shape written by persistSession() into sessions.json */
function makePersistedSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    encryptionKey: PERSISTED_KEY_BASE64,
    encryptionVariant: 'dataKey',
    seq: 0,
    metadataVersion: 1,
    agentStateVersion: 1,
    metadata: { path: '/tmp/persisted-session' } as unknown as Metadata,
    savedAt: Date.now(),
    ...overrides,
  };
}

function makeTrackedSession(overrides: Partial<TrackedSession> & { happySessionId: string }): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    ...overrides,
  };
}

async function postList(port: number): Promise<ListedDaemonSession[]> {
  const response = await fetch(`http://127.0.0.1:${port}/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  // Server-side shape is zod-validated by fastify-type-provider-zod; cast is safe here.
  const body = (await response.json()) as { children: ListedDaemonSession[] };
  return body.children;
}

describe('controlServer POST /list encryption exposure', () => {
  let children: TrackedSession[];
  let port = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    mockedReadPersistedSessions.mockReturnValue({});
    children = [];
    const server = await startDaemonControlServer({
      getChildren: () => children,
      stopSession: () => true,
      spawnSession: async () => ({ type: 'error', errorMessage: 'not implemented in test' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
    });
    port = server.port;
    stop = server.stop;
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('includes encryption { key, variant } for a tracked session with in-memory encryption', async () => {
    const keyBytes = new Uint8Array(32).map((_, i) => i);
    children.push(makeTrackedSession({
      happySessionId: 'session-with-key',
      encryption: {
        encryptionKey: keyBytes,
        encryptionVariant: 'dataKey',
        seq: 1,
        metadataVersion: 2,
        agentStateVersion: 3,
      },
    }));

    const [item] = await postList(port);

    expect(item.happySessionId).toBe('session-with-key');
    expect(item.encryption).toEqual({
      key: encodeBase64(keyBytes),
      variant: 'dataKey',
    });
  });

  it('omits the encryption field when the session has no encryption in memory or on disk', async () => {
    children.push(makeTrackedSession({ happySessionId: 'session-without-key' }));

    const [item] = await postList(port);

    expect(item.happySessionId).toBe('session-without-key');
    expect(item).not.toHaveProperty('encryption');
  });

  it('falls back to the persisted sessions.json entry when in-memory encryption is absent', async () => {
    mockedReadPersistedSessions.mockReturnValue({
      [PERSISTED_SESSION_ID]: makePersistedSession(),
    });
    children.push(makeTrackedSession({ happySessionId: PERSISTED_SESSION_ID }));

    const [item] = await postList(port);

    expect(item.happySessionId).toBe(PERSISTED_SESSION_ID);
    expect(item.encryption).toEqual({
      key: PERSISTED_KEY_BASE64,
      variant: 'dataKey',
    });
  });

  it('prefers in-memory encryption over the persisted entry for the same session', async () => {
    const keyBytes = new Uint8Array(32).fill(1);
    mockedReadPersistedSessions.mockReturnValue({
      'session-with-key': makePersistedSession({ encryptionVariant: 'legacy' }),
    });
    children.push(makeTrackedSession({
      happySessionId: 'session-with-key',
      encryption: {
        encryptionKey: keyBytes,
        encryptionVariant: 'dataKey',
        seq: 1,
        metadataVersion: 2,
        agentStateVersion: 3,
      },
    }));

    const [item] = await postList(port);

    expect(item.encryption).toEqual({
      key: encodeBase64(keyBytes),
      variant: 'dataKey',
    });
  });
});
