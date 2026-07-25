import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDaemonPort,
  listDaemonSessions,
  stopDaemonSession,
  readPersistedSessionKeys,
  resolveSessionKeys,
} from './daemonClient';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hd-daemon-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY_MS = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

function sessionsJson(entries: Record<string, unknown>) {
  return JSON.stringify({ sessions: entries });
}

describe('readDaemonPort', () => {
  it('reads httpPort from daemon.state.json', async () => {
    await writeFile(join(dir, 'daemon.state.json'), JSON.stringify({ pid: 1, httpPort: 45757 }));
    expect(await readDaemonPort(dir)).toBe(45757);
  });

  it('returns null when the file is missing or malformed', async () => {
    expect(await readDaemonPort(dir)).toBeNull();
    await writeFile(join(dir, 'daemon.state.json'), 'not json');
    expect(await readDaemonPort(dir)).toBeNull();
    await writeFile(join(dir, 'daemon.state.json'), JSON.stringify({ pid: 1 }));
    expect(await readDaemonPort(dir)).toBeNull();
  });
});

describe('listDaemonSessions', () => {
  it('parses children with and without encryption (old daemon tolerance)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      children: [
        { startedBy: 'daemon', happySessionId: 's1', pid: 10, agent: 'claude', path: '/repo' },
        {
          startedBy: 'daemon', happySessionId: 's2', pid: 11,
          encryption: { key: 'a2V5', variant: 'dataKey' },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const children = await listDaemonSessions(45757);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:45757/list', expect.objectContaining({ method: 'POST' }));
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ sessionId: 's1', pid: 10, agent: 'claude', path: '/repo' });
    expect(children[0].encryption).toBeUndefined();
    expect(children[1]).toMatchObject({ sessionId: 's2' });
    expect(children[1].encryption).toEqual({ key: 'a2V5', variant: 'dataKey' });
  });

  it('returns [] on network error, non-200, or malformed payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await listDaemonSessions(1)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await listDaemonSessions(1)).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    expect(await listDaemonSessions(1)).toEqual([]);
  });
});

describe('stopDaemonSession', () => {
  it('stops only the exact Happy session id requested', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stopDaemonSession(45757, 'spawned-test-session')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:45757/stop-session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sessionId: 'spawned-test-session' }),
      }),
    );
  });

  it('returns false without touching another session when cleanup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })));
    await expect(stopDaemonSession(45757, 'missing-test-session')).resolves.toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await expect(stopDaemonSession(45757, 'missing-test-session')).resolves.toBe(false);
  });
});

describe('readPersistedSessionKeys', () => {
  it('parses sessions.json entries with encryption material', async () => {
    await writeFile(join(dir, 'sessions.json'), sessionsJson({
      s1: {
        encryptionKey: 'a2V5MQ==', encryptionVariant: 'dataKey',
        seq: 0, metadataVersion: 0, agentStateVersion: 0,
        metadata: { path: '/repo' }, savedAt: NOW - DAY_MS,
      },
      s2: {
        encryptionKey: 'a2V5Mg==', encryptionVariant: 'legacy',
        savedAt: NOW - 2 * DAY_MS,
      },
    }));
    const keys = await readPersistedSessionKeys(dir, NOW);
    expect(keys.get('s1')).toEqual({ sessionId: 's1', encryptionKey: 'a2V5MQ==', encryptionVariant: 'dataKey' });
    expect(keys.get('s2')).toEqual({ sessionId: 's2', encryptionKey: 'a2V5Mg==', encryptionVariant: 'legacy' });
  });

  it('drops entries older than 14 days (mirrors readPersistedSessions)', async () => {
    await writeFile(join(dir, 'sessions.json'), sessionsJson({
      fresh: { encryptionKey: 'a2V5MQ==', encryptionVariant: 'dataKey', savedAt: NOW - 13 * DAY_MS },
      stale: { encryptionKey: 'a2V5Mg==', encryptionVariant: 'dataKey', savedAt: NOW - 15 * DAY_MS },
    }));
    const keys = await readPersistedSessionKeys(dir, NOW);
    expect(keys.has('fresh')).toBe(true);
    expect(keys.has('stale')).toBe(false);
  });

  it('skips malformed entries and tolerates a missing file', async () => {
    expect((await readPersistedSessionKeys(dir, NOW)).size).toBe(0);
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sessions.json'), sessionsJson({
      good: { encryptionKey: 'a2V5MQ==', encryptionVariant: 'dataKey', savedAt: NOW },
      noKey: { encryptionVariant: 'dataKey', savedAt: NOW },
      badVariant: { encryptionKey: 'a2V5Mg==', encryptionVariant: 'weird', savedAt: NOW },
    }));
    const keys = await readPersistedSessionKeys(dir, NOW);
    expect([...keys.keys()]).toEqual(['good']);
  });
});

describe('resolveSessionKeys', () => {
  it('prefers /list encryption, falls back to sessions.json, marks local sessions', async () => {
    await writeFile(join(dir, 'sessions.json'), sessionsJson({
      s1: { encryptionKey: 'ZnJvbUZpbGU=', encryptionVariant: 'legacy', savedAt: NOW },
      s2: { encryptionKey: 'ZmlsZUtleTI=', encryptionVariant: 'dataKey', savedAt: NOW },
      s3: { encryptionKey: 'ZmlsZUtleTM=', encryptionVariant: 'dataKey', savedAt: NOW },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      children: [
        { startedBy: 'daemon', happySessionId: 's1', pid: 1, encryption: { key: 'ZnJvbURhZW1vbg==', variant: 'dataKey' } },
        { startedBy: 'daemon', happySessionId: 's2', pid: 2 },
      ],
    }), { status: 200 })));

    const resolved = await resolveSessionKeys(dir, 45757, NOW);
    // /list wins for s1 (daemon key, variant overridden too)
    expect(resolved.keys.get('s1')).toEqual({ sessionId: 's1', encryptionKey: 'ZnJvbURhZW1vbg==', encryptionVariant: 'dataKey' });
    // sessions.json fallback for s2 (old daemon reported it without encryption)
    expect(resolved.keys.get('s2')).toEqual({ sessionId: 's2', encryptionKey: 'ZmlsZUtleTI=', encryptionVariant: 'dataKey' });
    // server-side-only session still gets its file key
    expect(resolved.keys.get('s3')?.encryptionKey).toBe('ZmlsZUtleTM=');
    // local = reported by daemon /list
    expect([...resolved.local].sort()).toEqual(['s1', 's2']);
  });

  it('works with no daemon at all (sessions.json only)', async () => {
    await writeFile(join(dir, 'sessions.json'), sessionsJson({
      s1: { encryptionKey: 'a2V5MQ==', encryptionVariant: 'dataKey', savedAt: NOW },
    }));
    const resolved = await resolveSessionKeys(dir, null, NOW);
    expect(resolved.keys.get('s1')?.encryptionKey).toBe('a2V5MQ==');
    expect(resolved.local.size).toBe(0);
    expect(resolved.children).toEqual([]);
  });
});
