import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getRandomBytes } from '../../../happy-cli/src/api/encryption';
import {
  deriveContentKeyPair as deriveAgentContentKeyPair,
  libsodiumEncryptForPublicKey,
} from '../../../happy-agent/src/encryption';
import { encodeBase64, encrypt, decrypt, decodeBase64 } from './encryption';
import type { RawSessionRecord } from './serverClient';
import type { DesktopState } from './types';

//
// Module mocks — engine orchestration is tested against mocked boundaries.
//

const server = vi.hoisted(() => {
  const instances: Array<Record<string, unknown>> = [];
  return { instances };
});

vi.mock('./serverClient', () => {
  class MockServerClient {
    updateHandlers = new Set<(u: unknown) => void>();
    ephemeralHandlers = new Set<(u: unknown) => void>();
    statusHandlers = new Set<(s: string) => void>();
    listSessions = vi.fn(async (): Promise<RawSessionRecord[]> => []);
    getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
    postMessages = vi.fn(async (_sid: string, messages: Array<{ localId: string; content: string }>) =>
      messages.map((m, i) => ({ id: `srv-${i}`, seq: 1, localId: m.localId, createdAt: 1, updatedAt: 1 })));
    machineRPC = vi.fn(async () => ({ type: 'success', sessionId: 'spawned-1' }));
    connect = vi.fn();
    disconnect = vi.fn(async () => undefined);
    onUpdate(h: (u: unknown) => void) { this.updateHandlers.add(h); return () => this.updateHandlers.delete(h); }
    onEphemeral(h: (u: unknown) => void) { this.ephemeralHandlers.add(h); return () => this.ephemeralHandlers.delete(h); }
    onStatus(h: (s: string) => void) { this.statusHandlers.add(h); return () => this.statusHandlers.delete(h); }
    constructor() {
      server.instances.push(this as unknown as Record<string, unknown>);
    }
  }
  return { ServerClient: MockServerClient };
});

const daemon = vi.hoisted(() => ({
  port: null as number | null,
  keys: new Map<string, { sessionId: string; encryptionKey: string; encryptionVariant: 'legacy' | 'dataKey' }>(),
  local: new Set<string>(),
}));

vi.mock('./daemonClient', () => ({
  readDaemonPort: vi.fn(async () => daemon.port),
  resolveSessionKeys: vi.fn(async () => ({
    keys: new Map(daemon.keys),
    local: new Set(daemon.local),
    children: [...daemon.local].map((sessionId) => ({ sessionId, pid: 1, startedBy: 'daemon' })),
  })),
  listDaemonSessions: vi.fn(async () => []),
  readPersistedSessionKeys: vi.fn(async () => new Map()),
}));

const hoistedCrypto = vi.hoisted(() => ({
  machineKey: new Uint8Array(32).fill(7),
  accountSecret: null as Uint8Array | null,
}));

vi.mock('./credentials', () => ({
  loadAccountSecret: vi.fn(async () =>
    hoistedCrypto.accountSecret ? new Uint8Array(hoistedCrypto.accountSecret) : null),
  loadCredentials: vi.fn(async () => ({
    token: 'tok',
    homeDir: '/tmp/hd',
    encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(3), machineKey: hoistedCrypto.machineKey },
  })),
  machineRpcKey: (creds: { encryption: { machineKey?: Uint8Array; secret?: Uint8Array; type: string } }) =>
    creds.encryption.type === 'dataKey'
      ? { key: creds.encryption.machineKey, variant: 'dataKey' }
      : { key: creds.encryption.secret, variant: 'legacy' },
  readMachineId: vi.fn(async () => 'machine-1'),
  defaultHappyHomeDir: () => '/tmp/hd',
}));

import { SyncEngine } from './syncEngine';

const SESSION_KEY = getRandomBytes(32);

function wrapDataKey(dataKey: Uint8Array, accountSecret: Uint8Array): string {
  const contentKeyPair = deriveAgentContentKeyPair(accountSecret);
  const encrypted = libsodiumEncryptForPublicKey(dataKey, contentKeyPair.publicKey);
  const wrapped = new Uint8Array(encrypted.length + 1);
  wrapped[0] = 0;
  wrapped.set(encrypted, 1);
  return encodeBase64(wrapped);
}

function mockServer(): {
  emit: (u: unknown) => void;
  emitEphemeral: (u: unknown) => void;
  emitStatus: (s: string) => void;
  instance: Record<string, any>;
} {
  const instance = server.instances[server.instances.length - 1] as Record<string, any>;
  return {
    instance,
    emit: (u) => { for (const h of instance.updateHandlers) h(u); },
    emitEphemeral: (u) => { for (const h of instance.ephemeralHandlers) h(u); },
    emitStatus: (s) => { for (const h of instance.statusHandlers) h(s); },
  };
}

async function makeSessionRecord(id: string, overrides: Partial<RawSessionRecord> = {}): Promise<RawSessionRecord> {
  const metadata = { path: '/repo/project', flavor: 'omp', machineId: 'machine-1', summary: { text: 'My chat', updatedAt: 1 } };
  return {
    id,
    tag: null,
    seq: 1,
    metadata: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', metadata)),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
    active: true,
    activeAt: 100,
    createdAt: 100,
    updatedAt: 200,
    lastMessage: null,
    ...overrides,
  };
}


async function bootEngine(records: RawSessionRecord[]): Promise<{ eng: SyncEngine; srv: ReturnType<typeof mockServer> }> {
  const eng = engine();
  const srv = mockServer();
  srv.instance.listSessions.mockResolvedValue(records);
  await eng.start();
  return { eng, srv };
}

function engine(): SyncEngine {
  return new SyncEngine({
    serverUrl: 'http://server:30003',
    credentials: { token: 'tok', homeDir: '/tmp/hd' },
  });
}

function nextState(eng: SyncEngine): Promise<DesktopState> {
  const { promise, resolve } = Promise.withResolvers<DesktopState>();
  eng.once('state', resolve);
  return promise;
}

beforeEach(() => {
  server.instances.length = 0;
  hoistedCrypto.accountSecret = null;
  daemon.keys.clear();
  daemon.local.clear();
  daemon.keys.set('s1', {
    sessionId: 's1',
    encryptionKey: encodeBase64(SESSION_KEY),
    encryptionVariant: 'dataKey',
  });
  daemon.local.add('s1');
});

describe('SyncEngine', () => {
  it('start() fetches sessions, decrypts metadata, and emits state', async () => {
    const record = await makeSessionRecord('s1');
    const { eng, srv } = await bootEngine([record]);

    const state = eng.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      id: 's1',
      title: 'My chat',
      path: '/repo/project',
      agent: 'omp',
      machineId: 'machine-1',
      active: true,
      local: true,
      keyAvailable: true,
    });
    expect(srv.instance.connect).toHaveBeenCalled();
    await eng.stop();
  });

  it('marks sessions without keys as keyAvailable:false and never decrypts', async () => {
    const record = await makeSessionRecord('s2'); // no key in daemon.keys
    const { eng } = await bootEngine([record]);

    const view = eng.getState().sessions[0];
    expect(view.keyAvailable).toBe(false);
    expect(view.local).toBe(false);
    expect(view.title).toBe('session s2');
    await eng.stop();
  });

  it('recovers a server-only session key and decrypts its metadata and messages', async () => {
    hoistedCrypto.accountSecret = getRandomBytes(32);
    const record = await makeSessionRecord('server-only', {
      dataEncryptionKey: wrapDataKey(SESSION_KEY, hoistedCrypto.accountSecret),
    });
    const { eng, srv } = await bootEngine([record]);

    expect(eng.getState().sessions[0]).toMatchObject({
      id: 'server-only',
      title: 'My chat',
      local: false,
      keyAvailable: true,
    });

    const message = { role: 'user', content: { type: 'text', text: 'from server-only session' } };
    srv.instance.getMessages.mockResolvedValue({
      hasMore: false,
      messages: [{
        id: 'server-message',
        seq: 1,
        content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', message)) },
        localId: null,
        createdAt: 20,
        updatedAt: 20,
      }],
    });
    await eng.openSession('server-only');
    expect(eng.getState().messages['server-only']?.[0]?.text).toBe('from server-only session');
    await eng.stop();
  });

  it('keeps a local raw key ahead of a valid but different server-wrapped key', async () => {
    hoistedCrypto.accountSecret = getRandomBytes(32);
    const differentKey = getRandomBytes(32);
    const record = await makeSessionRecord('s1', {
      dataEncryptionKey: wrapDataKey(differentKey, hoistedCrypto.accountSecret),
    });
    const { eng } = await bootEngine([record]);

    expect(eng.getState().sessions[0]).toMatchObject({
      id: 's1',
      title: 'My chat',
      local: true,
      keyAvailable: true,
    });
    await eng.stop();
  });

  it('leaves malformed wrapped keys locked without failing other sessions', async () => {
    hoistedCrypto.accountSecret = getRandomBytes(32);
    const local = await makeSessionRecord('s1');
    const inaccessible = await makeSessionRecord('inaccessible', {
      dataEncryptionKey: 'not-a-wrapped-key',
    });
    const { eng } = await bootEngine([local, inaccessible]);

    expect(eng.getState().sessions.find((session) => session.id === 's1')).toMatchObject({
      title: 'My chat',
      keyAvailable: true,
    });
    expect(eng.getState().sessions.find((session) => session.id === 'inaccessible')).toMatchObject({
      title: 'session inacce',
      keyAvailable: false,
    });
    await eng.stop();
  });

  it('continues to use local legacy session keys unchanged', async () => {
    const legacyKey = getRandomBytes(32);
    daemon.keys.clear();
    daemon.local.clear();
    daemon.keys.set('legacy', {
      sessionId: 'legacy',
      encryptionKey: encodeBase64(legacyKey),
      encryptionVariant: 'legacy',
    });
    daemon.local.add('legacy');
    const record = await makeSessionRecord('legacy', {
      metadata: encodeBase64(await encrypt(legacyKey, 'legacy', {
        path: '/legacy',
        summary: { text: 'Legacy chat' },
      })),
    });
    const { eng } = await bootEngine([record]);

    expect(eng.getState().sessions[0]).toMatchObject({
      id: 'legacy',
      title: 'Legacy chat',
      path: '/legacy',
      local: true,
      keyAvailable: true,
    });
    await eng.stop();
  });

  it('openSession fetches, decrypts, and orders messages', async () => {
    const { eng, srv } = await bootEngine([await makeSessionRecord('s1')]);

    const m1 = { role: 'user', content: { type: 'text', text: 'first' } };
    const m2 = { role: 'agent', content: { type: 'acp', provider: 'omp', data: { type: 'message', message: 'second' } } };
    srv.instance.getMessages.mockResolvedValue({
      hasMore: false,
      messages: [
        { id: 'm2', seq: 2, content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', m2)) }, localId: null, createdAt: 20, updatedAt: 20 },
        { id: 'm1', seq: 1, content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', m1)) }, localId: null, createdAt: 10, updatedAt: 10 },
      ],
    });

    await eng.openSession('s1');
    const messages = eng.getState().messages['s1'];
    expect(messages.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, 'user', 'first'],
      [2, 'agent', 'second'],
    ]);
    await eng.stop();
  });

  it('applies socket new-message on the fast path and sets thinking from lifecycle', async () => {
    const { eng, srv } = await bootEngine([await makeSessionRecord('s1')]);
    srv.instance.getMessages.mockResolvedValue({ messages: [], hasMore: false });
    await eng.openSession('s1');

    const acp = { role: 'agent', content: { type: 'acp', provider: 'omp', data: { type: 'message', message: 'live chunk' } } };
    srv.emit({
      id: 'u1', seq: 5, createdAt: 300,
      body: {
        t: 'new-message', sid: 's1',
        message: { id: 'm1', seq: 1, content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', acp)) }, localId: null, createdAt: 300 },
      },
    });
    await vi.waitFor(() => expect(eng.getState().messages['s1']?.[0]?.text).toBe('live chunk'));
    expect(eng.getState().sessions[0].updatedAt).toBe(300);

    // task_started lifecycle marks the session thinking
    const started = { role: 'agent', content: { type: 'acp', provider: 'omp', data: { type: 'task_started', id: 't1' } } };
    srv.emit({
      id: 'u2', seq: 6, createdAt: 310,
      body: {
        t: 'new-message', sid: 's1',
        message: { id: 'm2', seq: 2, content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', started)) }, localId: null, createdAt: 310 },
      },
    });
    await vi.waitFor(() => expect(eng.getState().sessions[0].thinking).toBe(true));
    await eng.stop();
  });

  it('ephemeral activity updates thinking/active flags', async () => {
    const { eng, srv } = await bootEngine([await makeSessionRecord('s1')]);

    srv.emitEphemeral({ type: 'activity', id: 's1', active: true, activeAt: 1, thinking: true });
    expect(eng.getState().sessions[0].thinking).toBe(true);
    srv.emitEphemeral({ type: 'activity', id: 's1', active: true, activeAt: 2, thinking: false });
    expect(eng.getState().sessions[0].thinking).toBe(false);
    await eng.stop();
  });

  it('sendMessage encrypts the raw record, posts it, and replaces the optimistic copy on echo', async () => {
    const { eng, srv } = await bootEngine([await makeSessionRecord('s1')]);
    srv.instance.getMessages.mockResolvedValue({ messages: [], hasMore: false });
    await eng.openSession('s1');

    await eng.sendMessage('s1', 'hello agent');

    // Outbox POST carried an encrypted user record decryptable with the session key
    const [sid, batch] = srv.instance.postMessages.mock.calls[0] as [string, Array<{ localId: string; content: string }>];
    expect(sid).toBe('s1');
    const decrypted = await decrypt(SESSION_KEY, 'dataKey', decodeBase64(batch[0].content));
    expect(decrypted).toMatchObject({ role: 'user', content: { type: 'text', text: 'hello agent' } });

    // Optimistic copy is in the store under local:<localId>
    expect(eng.getState().messages['s1'].map((m) => m.id)).toEqual([`local:${batch[0].localId}`]);

    // Server echo with the same localId replaces it
    const echo = { role: 'user', content: { type: 'text', text: 'hello agent' } };
    srv.emit({
      id: 'u1', seq: 9, createdAt: 400,
      body: {
        t: 'new-message', sid: 's1',
        message: { id: 'srv-1', seq: 1, content: { t: 'encrypted', c: encodeBase64(await encrypt(SESSION_KEY, 'dataKey', echo)) }, localId: batch[0].localId, createdAt: 400 },
      },
    });
    await vi.waitFor(() => expect(eng.getState().messages['s1'].map((m) => m.id)).toEqual(['srv-1']));
    await eng.stop();
  });

  it('sendMessage drops the optimistic copy when the POST fails', async () => {
    const { eng, srv } = await bootEngine([await makeSessionRecord('s1')]);
    srv.instance.getMessages.mockResolvedValue({ messages: [], hasMore: false });
    await eng.openSession('s1');
    srv.instance.postMessages.mockRejectedValueOnce(new Error('Failed to send messages for s1: 500'));

    await expect(eng.sendMessage('s1', 'will fail')).rejects.toThrow(/500/);
    expect(eng.getState().messages['s1']).toEqual([]);
    await eng.stop();
  });

  it('sendMessage rejects when no key is available', async () => {
    const { eng } = await bootEngine([await makeSessionRecord('s2')]);
    await expect(eng.sendMessage('s2', 'hi')).rejects.toThrow(/No encryption key/);
    await eng.stop();
  });

  it('spawnSession issues machineRPC spawn-happy-session with spawn-in-directory params', async () => {
    const { eng, srv } = await bootEngine([]);
    expect(srv.instance.connect).toHaveBeenCalled();

    const result = await eng.spawnSession('machine-1', '/home/user/projects/x', 'omp');
    expect(result).toEqual({ type: 'success', sessionId: 'spawned-1' });
    const [machineId, method, params] = srv.instance.machineRPC.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(machineId).toBe('machine-1');
    expect(method).toBe('spawn-happy-session');
    expect(params).toMatchObject({ type: 'spawn-in-directory', directory: '/home/user/projects/x', agent: 'omp' });
    await eng.stop();
  });

  it('emits state after changes and tracks socket status', async () => {
    const { eng, srv } = await bootEngine([]);
    const emission = nextState(eng);
    srv.emitStatus('online');
    const state = await emission;
    expect(state.status).toBe('online');
    expect(eng.getState().status).toBe('online');
    await eng.stop();
    expect(eng.getState().status).toBe('offline');
  });

  it('re-runs a refresh requested while another refresh is in flight', async () => {
    const { eng, srv } = await bootEngine([]);
    expect(srv.instance.listSessions).toHaveBeenCalledTimes(1);

    // Next refresh blocks on a gate; the follow-up refresh returns the new session.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const record = await makeSessionRecord('s1');
    srv.instance.listSessions
      .mockImplementationOnce(async () => { await gate; return []; })
      .mockResolvedValue([record]);

    // Two back-to-back triggers: the second lands while the first is in flight.
    srv.emit({ body: { t: 'new-session' }, createdAt: 1 });
    srv.emit({ body: { t: 'new-session' }, createdAt: 2 });
    release();

    // The in-flight refresh saw no session; the queued re-run must pick it up.
    await vi.waitFor(() => expect(srv.instance.listSessions.mock.calls.length).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() => expect(eng.getState().sessions.map((s) => s.id)).toContain('s1'));
    await eng.stop();
  });
});
