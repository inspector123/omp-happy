import { describe, it, expect } from 'vitest';
import { createDesktopStore } from './store';
import type { MessageView, SessionView } from './types';
import type { NormalizedView } from './normalize';

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id, active: false, thinking: false, updatedAt: 1000,
    title: `session ${id.slice(0, 6)}`, local: false, keyAvailable: true,
    ...overrides,
  };
}

function msg(id: string, seq: number, overrides: Partial<MessageView> = {}): NormalizedView {
  return {
    view: {
      id, seq, createdAt: seq * 10, role: 'agent', kind: 'text', text: `m${seq}`,
      ...overrides,
    },
  };
}

describe('desktop store', () => {
  it('starts in connecting status with empty state', () => {
    const store = createDesktopStore();
    const snap = store.getSnapshot();
    expect(snap.status).toBe('connecting');
    expect(snap.sessions).toEqual([]);
    expect(snap.messages).toEqual({});
    expect(snap.error).toBeUndefined();
  });

  it('upserts sessions and keeps them sorted by updatedAt desc', () => {
    const store = createDesktopStore();
    store.upsertSessions([
      session('a', { updatedAt: 100 }),
      session('b', { updatedAt: 300 }),
      session('c', { updatedAt: 200 }),
    ]);
    expect(store.getSnapshot().sessions.map(s => s.id)).toEqual(['b', 'c', 'a']);

    // Upsert existing session -> updates fields, re-sorts, does not duplicate
    store.upsertSession(session('a', { updatedAt: 500, title: 'renamed' }));
    const sessions = store.getSnapshot().sessions;
    expect(sessions.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(sessions[0].title).toBe('renamed');
    expect(sessions).toHaveLength(3);
  });

  it('prunes sessions not present in a full refresh', () => {
    const store = createDesktopStore();
    store.upsertSessions([session('a'), session('b')], { prune: true });
    expect(store.getSnapshot().sessions.map(s => s.id)).toEqual(['a', 'b']);
    store.upsertSessions([session('b')], { prune: true });
    expect(store.getSnapshot().sessions.map(s => s.id)).toEqual(['b']);
  });

  it('removes sessions and their messages', () => {
    const store = createDesktopStore();
    store.upsertSession(session('a'));
    store.applyMessages('a', [msg('m1', 1)]);
    store.removeSession('a');
    const snap = store.getSnapshot();
    expect(snap.sessions).toEqual([]);
    expect(snap.messages['a']).toBeUndefined();
  });

  it('orders messages by seq ascending regardless of insertion order', () => {
    const store = createDesktopStore();
    store.applyMessages('s', [msg('m3', 3), msg('m1', 1), msg('m2', 2)]);
    expect(store.getSnapshot().messages['s'].map(m => m.seq)).toEqual([1, 2, 3]);

    // Later single-message insert lands in the right position
    store.applyMessages('s', [msg('m0', 0)]);
    expect(store.getSnapshot().messages['s'].map(m => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it('dedupes messages by id, replacing the stored copy', () => {
    const store = createDesktopStore();
    store.applyMessages('s', [msg('m1', 1, { text: 'old' })]);
    store.applyMessages('s', [msg('m1', 1, { text: 'new' })]);
    const messages = store.getSnapshot().messages['s'];
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('new');
  });

  it('merges appendable stream chunks into one message', () => {
    const store = createDesktopStore();
    store.applyMessages('s', [{
      view: { id: 'stream:s1', seq: 1, createdAt: 10, role: 'agent', kind: 'text', text: 'Hello ' },
      stream: { streamId: 's1', append: false },
    }]);
    store.applyMessages('s', [{
      view: { id: 'stream:s1', seq: 2, createdAt: 20, role: 'agent', kind: 'text', text: 'world' },
      stream: { streamId: 's1', append: true },
    }]);
    const messages = store.getSnapshot().messages['s'];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'stream:s1', text: 'Hello world', seq: 2, createdAt: 10 });
  });

  it('replaces optimistic outbox copies when the server echoes localId', () => {
    const store = createDesktopStore();
    store.applyMessages('s', [{
      view: { id: 'local:loc-1', seq: 6, createdAt: 60, role: 'user', kind: 'text', text: 'hi' },
    }]);
    store.applyMessages('s', [{
      view: { id: 'srv-9', seq: 6, createdAt: 61, role: 'user', kind: 'text', text: 'hi' },
      localId: 'loc-1',
    }]);
    const messages = store.getSnapshot().messages['s'];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('srv-9');
  });

  it('drops a message by id (failed optimistic send)', () => {
    const store = createDesktopStore();
    store.applyMessages('s', [msg('m1', 1), msg('m2', 2)]);
    store.dropMessage('s', 'm1');
    expect(store.getSnapshot().messages['s'].map(m => m.id)).toEqual(['m2']);
  });

  it('sets thinking and active flags from ephemeral activity', () => {
    const store = createDesktopStore();
    store.upsertSession(session('a'));
    store.setSessionActivity('a', { thinking: true, active: true });
    let view = store.getSnapshot().sessions[0];
    expect(view.thinking).toBe(true);
    expect(view.active).toBe(true);

    store.setSessionActivity('a', { thinking: false, active: true });
    view = store.getSnapshot().sessions[0];
    expect(view.thinking).toBe(false);
    expect(view.active).toBe(true);
  });

  it('creates a placeholder session for activity on an unknown session', () => {
    const store = createDesktopStore();
    store.setSessionActivity('ghost', { thinking: true, active: true });
    const view = store.getSnapshot().sessions[0];
    expect(view.id).toBe('ghost');
    expect(view.thinking).toBe(true);
  });

  it('tracks status and error', () => {
    const store = createDesktopStore();
    store.setStatus('online');
    expect(store.getSnapshot().status).toBe('online');
    store.setError('boom');
    expect(store.getSnapshot().error).toBe('boom');
    store.setError(undefined);
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('notifies subscribers with a full snapshot on change', () => {
    const store = createDesktopStore();
    const seen: string[] = [];
    const unsub = store.subscribe(snap => seen.push(snap.status));
    store.setStatus('online');
    store.setStatus('offline');
    unsub();
    store.setStatus('connecting');
    expect(seen).toEqual(['online', 'offline']);
  });
});
