import { describe, it, expect, afterEach, vi } from 'vitest';
import { ServerClient } from './serverClient';

const SERVER = 'http://192.168.0.252:30003';
const TOKEN = 'test-token';

function client() {
  return new ServerClient({ serverUrl: SERVER, token: TOKEN });
}

type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>): FetchMock {
  const mock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerClient REST', () => {
  it('listSessions GETs /v1/sessions with bearer auth', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({
      sessions: [{
        id: 's1', tag: 't', seq: 3, metadata: 'enc-meta', metadataVersion: 2,
        agentState: null, agentStateVersion: 0, dataEncryptionKey: 'enc-key',
        active: true, activeAt: 111, createdAt: 100, updatedAt: 200,
        lastMessage: null,
      }],
    }));

    const sessions = await client().listSessions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVER}/v1/sessions`);
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('X-Happy-Client')).toMatch(/^happy-desktop\//);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 's1', seq: 3, metadata: 'enc-meta', metadataVersion: 2,
      agentState: null, active: true, updatedAt: 200,
    });
  });

  it('listSessions tolerates missing optional fields and drops malformed entries', async () => {
    mockFetch(async () => jsonResponse({
      sessions: [
        { id: 's1', metadata: 'm', metadataVersion: 0, agentStateVersion: 0, active: false, createdAt: 1, updatedAt: 2 },
        { noId: true },
        'garbage',
      ],
    }));
    const sessions = await client().listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 's1', seq: 0, agentState: null, dataEncryptionKey: null, activeAt: 0, lastMessage: null });
  });

  it('throws on non-ok responses', async () => {
    mockFetch(async () => new Response('nope', { status: 401 }));
    await expect(client().listSessions()).rejects.toThrow(/401/);
  });

  it('getMessages builds forward (after_seq) and backward (before_seq) queries', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ messages: [], hasMore: false }));

    await client().getMessages('s1', { afterSeq: 41, limit: 100 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/v3/sessions/s1/messages?after_seq=41&limit=100`);

    await client().getMessages('s1', { beforeSeq: 2147483647, limit: 100 });
    expect(fetchMock.mock.calls[1][0]).toBe(`${SERVER}/v3/sessions/s1/messages?before_seq=2147483647&limit=100`);
  });

  it('getMessages parses the v3 envelope', async () => {
    mockFetch(async () => jsonResponse({
      hasMore: true,
      messages: [
        { id: 'm1', seq: 1, content: { t: 'encrypted', c: 'Y2lwaGVy' }, localId: null, createdAt: 10, updatedAt: 10 },
        { id: 'm2', seq: 2, content: { t: 'encrypted', c: 'Y2lwaGVyMg==' }, localId: 'loc-1', createdAt: 20, updatedAt: 20 },
      ],
    }));
    const page = await client().getMessages('s1', { afterSeq: 0, limit: 100 });
    expect(page.hasMore).toBe(true);
    expect(page.messages.map(m => [m.id, m.seq, m.content.c, m.localId])).toEqual([
      ['m1', 1, 'Y2lwaGVy', null],
      ['m2', 2, 'Y2lwaGVyMg==', 'loc-1'],
    ]);
  });

  it('postMessages POSTs the outbox batch and parses accepted messages', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({
      messages: [{ id: 'm9', seq: 9, localId: 'loc-1', createdAt: 90, updatedAt: 90 }],
    }));

    const result = await client().postMessages('s1', [{ localId: 'loc-1', content: 'ZW5j' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVER}/v3/sessions/s1/messages`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ localId: 'loc-1', content: 'ZW5j' }] });
    expect(result).toEqual([{ id: 'm9', seq: 9, localId: 'loc-1', createdAt: 90, updatedAt: 90 }]);
  });

  it('postMessages throws on non-ok', async () => {
    mockFetch(async () => new Response('bad', { status: 500 }));
    await expect(client().postMessages('s1', [])).rejects.toThrow(/500/);
  });
});
