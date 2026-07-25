import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockBridge,
  filterSessions,
  formatRelativeTime,
  normalizeMessages,
  selectSelectedMessages,
  truncateMiddle,
  useDesktop,
  setBridge,
  type DesktopState,
  type HDBridge,
  type MessageView,
  type SessionView,
} from './api';

function makeSession(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    active: false,
    thinking: false,
    updatedAt: 1000,
    title: 'session one',
    path: '~/projects/one',
    agent: 'omp',
    local: true,
    keyAvailable: true,
    ...over,
  };
}

function makeMessage(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm1',
    seq: 1,
    createdAt: 1000,
    role: 'agent',
    kind: 'text',
    text: 'hello',
    ...over,
  };
}

function makeState(over: Partial<DesktopState> = {}): DesktopState {
  return {
    status: 'online',
    sessions: [makeSession()],
    messages: { s1: [makeMessage()] },
    ...over,
  };
}

function resetStore() {
  useDesktop.setState({
    status: 'connecting',
    sessions: [],
    messages: {},
    error: undefined,
    hydrated: false,
    selectedSessionId: null,
    unseen: {},
    switcherOpen: false,
  });
}

beforeEach(() => {
  resetStore();
  setBridge(null);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createMockBridge', () => {
  it('returns a realistic state: sorted sessions, a locked session, seq-asc messages', async () => {
    const bridge = createMockBridge({ background: false });
    const state = await bridge.getState();

    expect(state.status).toBe('online');
    expect(state.sessions.length).toBeGreaterThanOrEqual(5);

    // sorted by updatedAt desc
    for (let i = 1; i < state.sessions.length; i++) {
      expect(state.sessions[i - 1].updatedAt).toBeGreaterThanOrEqual(state.sessions[i].updatedAt);
    }

    // at least one encrypted (no key) session
    const locked = state.sessions.filter((s) => !s.keyAvailable);
    expect(locked.length).toBeGreaterThanOrEqual(1);

    // every unlocked session has seq-ascending messages with required fields
    for (const s of state.sessions) {
      const msgs = state.messages[s.id] ?? [];
      expect(msgs.length).toBeGreaterThan(0);
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].seq).toBeGreaterThanOrEqual(msgs[i - 1].seq);
      }
      for (const m of msgs) {
        expect(m.id).toBeTruthy();
        expect(m.text).toBeTruthy();
      }
      // a variety of agents
    }
    const agents = new Set(state.sessions.map((s) => s.agent));
    expect(agents.size).toBeGreaterThanOrEqual(2);
  });

  it('pushes state to onState subscribers and unsubscribes cleanly', async () => {
    const bridge = createMockBridge({ background: false });
    const sid = (await bridge.getState()).sessions[0].id;
    const seen: DesktopState[] = [];
    const unsub = bridge.onState((s) => seen.push(s));
    await bridge.sendMessage(sid, 'hi there');
    expect(seen.length).toBeGreaterThan(0);
    const after = seen.length;
    unsub();
    await bridge.sendMessage(sid, 'again');
    expect(seen.length).toBe(after);
  });

  it('sendMessage echoes the user message and streams an agent reply over time', async () => {
    const bridge = createMockBridge({ background: false });
    const state = await bridge.getState();
    const sid = state.sessions[0].id;

    const snapshots: DesktopState[] = [];
    bridge.onState((s) => snapshots.push(s));

    await bridge.sendMessage(sid, 'please fix the bug');

    // user message echoed immediately
    let msgs = snapshots.at(-1)!.messages[sid];
    expect(msgs.at(-1)!.role).toBe('user');
    expect(msgs.at(-1)!.text).toBe('please fix the bug');

    // streaming: over the next seconds an agent message appears and grows
    vi.advanceTimersByTime(20_000);
    const finalMsgs = snapshots.at(-1)!.messages[sid];
    const agentMsgs = finalMsgs.filter((m) => m.role === 'agent');
    expect(agentMsgs.length).toBeGreaterThan(0);
    const streamed = agentMsgs.at(-1)!;
    expect(streamed.text.length).toBeGreaterThan(10);

    // growth observed across snapshots (smooth append)
    const lengths = snapshots.map((s) => {
      const list = s.messages[sid].filter((m) => m.role === 'agent');
      return list.length ? list.at(-1)!.text.length : 0;
    });
    const maxLen = Math.max(...lengths);
    const distinct = new Set(lengths);
    expect(distinct.size).toBeGreaterThan(3); // multiple incremental appends
    expect(maxLen).toBeGreaterThan(10);

    // thinking flag cleared once streaming completes
    const finalSession = snapshots.at(-1)!.sessions.find((s) => s.id === sid)!;
    expect(finalSession.thinking).toBe(false);

    // seq ordering preserved
    for (let i = 1; i < finalMsgs.length; i++) {
      expect(finalMsgs[i].seq).toBeGreaterThanOrEqual(finalMsgs[i - 1].seq);
    }
    expect(msgs).toBeDefined();
  });

  it('simulates background activity on other sessions (for unseen-dot demo)', async () => {
    const bridge = createMockBridge({ background: true });
    const state = await bridge.getState();
    const snapshots: DesktopState[] = [];
    bridge.onState((s) => snapshots.push(s));
    vi.advanceTimersByTime(60_000);
    expect(snapshots.length).toBeGreaterThan(0);
    const before = new Map(state.sessions.map((s) => [s.id, s.updatedAt]));
    const bumped = snapshots.at(-1)!.sessions.filter((s) => s.updatedAt > (before.get(s.id) ?? 0));
    expect(bumped.length).toBeGreaterThan(0);
  });
});

describe('store: hydration and selection', () => {
  it('first applyState hydrates and auto-selects the first session', () => {
    const state = makeState({
      sessions: [makeSession({ id: 'a' }), makeSession({ id: 'b', updatedAt: 900 })],
    });
    useDesktop.getState().applyState(state);
    const s = useDesktop.getState();
    expect(s.hydrated).toBe(true);
    expect(s.selectedSessionId).toBe('a');
    expect(s.unseen).toEqual({});
    expect(s.status).toBe('online');
  });

  it('drops selection if the selected session disappears', () => {
    useDesktop.getState().applyState(makeState({ sessions: [makeSession({ id: 'a' })] }));
    expect(useDesktop.getState().selectedSessionId).toBe('a');
    useDesktop.getState().applyState(makeState({ sessions: [makeSession({ id: 'b' })], messages: {} }));
    expect(useDesktop.getState().selectedSessionId).toBe('b');
  });

  it('keeps manual selection across updates', () => {
    useDesktop.getState().applyState(
      makeState({ sessions: [makeSession({ id: 'a' }), makeSession({ id: 'b', updatedAt: 900 })] }),
    );
    useDesktop.getState().selectSession('b');
    useDesktop.getState().applyState(
      makeState({ sessions: [makeSession({ id: 'a', updatedAt: 2000 }), makeSession({ id: 'b', updatedAt: 900 })] }),
    );
    expect(useDesktop.getState().selectedSessionId).toBe('b');
  });
});

describe('store: unseen tracking', () => {
  function twoSessions() {
    return makeState({
      sessions: [
        makeSession({ id: 'a', updatedAt: 1000 }),
        makeSession({ id: 'b', updatedAt: 900 }),
      ],
    });
  }

  it('marks a non-selected session unseen when its updatedAt advances', () => {
    useDesktop.getState().applyState(twoSessions()); // selects 'a'
    useDesktop.getState().applyState(
      makeState({
        sessions: [makeSession({ id: 'a', updatedAt: 1000 }), makeSession({ id: 'b', updatedAt: 1500 })],
      }),
    );
    expect(useDesktop.getState().unseen).toEqual({ b: true });
  });

  it('does not mark the selected session unseen', () => {
    useDesktop.getState().applyState(twoSessions());
    useDesktop.getState().applyState(
      makeState({
        sessions: [makeSession({ id: 'a', updatedAt: 2000 }), makeSession({ id: 'b', updatedAt: 900 })],
      }),
    );
    expect(useDesktop.getState().unseen).toEqual({});
  });

  it('marks brand-new sessions (appearing after hydration) unseen', () => {
    useDesktop.getState().applyState(twoSessions());
    useDesktop.getState().applyState(
      makeState({
        sessions: [
          makeSession({ id: 'c', updatedAt: 3000, title: 'remote session' }),
          makeSession({ id: 'a', updatedAt: 1000 }),
          makeSession({ id: 'b', updatedAt: 900 }),
        ],
      }),
    );
    expect(useDesktop.getState().unseen).toEqual({ c: true });
  });

  it('selectSession clears the unseen flag for that session', () => {
    useDesktop.getState().applyState(twoSessions());
    useDesktop.getState().applyState(
      makeState({
        sessions: [makeSession({ id: 'a', updatedAt: 1000 }), makeSession({ id: 'b', updatedAt: 1500 })],
      }),
    );
    expect(useDesktop.getState().unseen.b).toBe(true);
    useDesktop.getState().selectSession('b');
    expect(useDesktop.getState().unseen.b).toBeUndefined();
    expect(useDesktop.getState().selectedSessionId).toBe('b');
  });

  it('selectSession calls openSession on the bridge', async () => {
    const opened: string[] = [];
    const bridge: HDBridge = {
      getState: async () => makeState(),
      onState: () => () => {},
      sendMessage: async () => {},
      openSession: async (id) => {
        opened.push(id);
      },
    };
    setBridge(bridge);
    useDesktop.getState().applyState(twoSessions());
    useDesktop.getState().selectSession('b');
    // async function body runs synchronously up to the first await
    expect(opened).toEqual(['b']);
  });

  it('cycleSelection moves up/down with wraparound and clears unseen', () => {
    useDesktop.getState().applyState(
      makeState({
        sessions: [
          makeSession({ id: 'a', updatedAt: 3000 }),
          makeSession({ id: 'b', updatedAt: 2000 }),
          makeSession({ id: 'c', updatedAt: 1000 }),
        ],
      }),
    );
    const st = () => useDesktop.getState();
    expect(st().selectedSessionId).toBe('a');
    st().cycleSelection(1);
    expect(st().selectedSessionId).toBe('b');
    st().cycleSelection(1);
    expect(st().selectedSessionId).toBe('c');
    st().cycleSelection(1); // wraps to top
    expect(st().selectedSessionId).toBe('a');
    st().cycleSelection(-1); // wraps to bottom
    expect(st().selectedSessionId).toBe('c');
  });

  it('selectByIndex selects the nth session and ignores out-of-range', () => {
    useDesktop.getState().applyState(
      makeState({
        sessions: [makeSession({ id: 'a' }), makeSession({ id: 'b', updatedAt: 900 })],
      }),
    );
    const st = () => useDesktop.getState();
    st().selectByIndex(1);
    expect(st().selectedSessionId).toBe('b');
    st().selectByIndex(9);
    expect(st().selectedSessionId).toBe('b');
  });
});

describe('store: messages', () => {
  it('normalizeMessages dedupes by id and sorts by seq', () => {
    const input = [
      makeMessage({ id: 'x', seq: 3 }),
      makeMessage({ id: 'y', seq: 1 }),
      makeMessage({ id: 'x', seq: 3, text: 'dupe' }),
      makeMessage({ id: 'z', seq: 2 }),
    ];
    const out = normalizeMessages(input);
    expect(out.map((m) => m.id)).toEqual(['y', 'z', 'x']);
  });

  it('applyState stores messages seq-asc even if delivered unsorted', () => {
    useDesktop.getState().applyState(
      makeState({
        messages: {
          s1: [makeMessage({ id: 'b', seq: 2 }), makeMessage({ id: 'a', seq: 1 })],
        },
      }),
    );
    expect(useDesktop.getState().messages.s1.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('send appends an optimistic user message and calls the bridge', async () => {
    const sent: Array<[string, string]> = [];
    const bridge: HDBridge = {
      getState: async () => makeState(),
      onState: () => () => {},
      sendMessage: async (sid, text) => {
        sent.push([sid, text]);
      },
      openSession: async () => {},
    };
    setBridge(bridge);
    useDesktop.getState().applyState(makeState());
    await useDesktop.getState().send('  hello world\n');

    expect(sent).toEqual([['s1', 'hello world']]);
    const msgs = useDesktop.getState().messages.s1;
    const last = msgs.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.text).toBe('hello world');
    expect(last.seq).toBeGreaterThan(msgs[0].seq);
  });

  it('send is a no-op while offline', async () => {
    let calls = 0;
    const bridge: HDBridge = {
      getState: async () => makeState(),
      onState: () => () => {},
      sendMessage: async () => {
        calls++;
      },
      openSession: async () => {},
    };
    setBridge(bridge);
    useDesktop.getState().applyState(makeState({ status: 'offline' }));
    await useDesktop.getState().send('hi');
    expect(calls).toBe(0);
    expect(useDesktop.getState().messages.s1.filter((m) => m.text === 'hi')).toEqual([]);
  });

  it('send removes the optimistic message and records the error on bridge failure', async () => {
    const bridge: HDBridge = {
      getState: async () => makeState(),
      onState: () => () => {},
      sendMessage: async () => {
        throw new Error('socket dead');
      },
      openSession: async () => {},
    };
    setBridge(bridge);
    useDesktop.getState().applyState(makeState());
    await useDesktop.getState().send('will fail');
    expect(useDesktop.getState().error).toContain('socket dead');
    expect(useDesktop.getState().messages.s1.filter((m) => m.text === 'will fail')).toEqual([]);
  });

  it('reconciles the optimistic echo once the real user message arrives', async () => {
    let listener: ((s: DesktopState) => void) | null = null;
    const bridge: HDBridge = {
      getState: async () => makeState(),
      onState: (cb) => {
        listener = cb;
        return () => {};
      },
      sendMessage: async (sid, text) => {
        // engine round-trip: real user message comes back in the next state push
        listener?.(
          makeState({
            messages: {
              [sid]: [
                makeMessage({ id: 'm1', seq: 1 }),
                makeMessage({ id: 'real-2', seq: 2, role: 'user', text }),
              ],
            },
          }),
        );
      },
      openSession: async () => {},
    };
    setBridge(bridge);
    useDesktop.getState().applyState(makeState());
    bridge.onState((s) => useDesktop.getState().applyState(s));
    await useDesktop.getState().send('echo me');

    const msgs = useDesktop.getState().messages.s1;
    expect(msgs.filter((m) => m.text === 'echo me')).toHaveLength(1);
    expect(msgs.find((m) => m.text === 'echo me')!.id).toBe('real-2');
    // ordering intact
    expect(msgs.map((m) => m.seq)).toEqual([...msgs.map((m) => m.seq)].sort((a, b) => a - b));
  });
});

describe('store: switcher', () => {
  it('toggleSwitcher flips and forces state', () => {
    const st = () => useDesktop.getState();
    expect(st().switcherOpen).toBe(false);
    st().toggleSwitcher();
    expect(st().switcherOpen).toBe(true);
    st().toggleSwitcher();
    expect(st().switcherOpen).toBe(false);
    st().toggleSwitcher(true);
    st().toggleSwitcher(true);
    expect(st().switcherOpen).toBe(true);
  });
});

describe('selectSelectedMessages', () => {
  it('returns a cached reference across calls (useSyncExternalStore stability, React #185)', () => {
    resetStore();
    const empty = useDesktop.getState();
    expect(selectSelectedMessages(empty)).toBe(selectSelectedMessages(empty));

    // selected session without loaded messages: still stable
    useDesktop.getState().applyState(makeState({ messages: {} }));
    const noMsgs = useDesktop.getState();
    expect(noMsgs.selectedSessionId).toBe('s1');
    expect(selectSelectedMessages(noMsgs)).toBe(selectSelectedMessages(noMsgs));

    // loaded messages: returns the stored array itself
    useDesktop.getState().applyState(makeState());
    const loaded = useDesktop.getState();
    expect(selectSelectedMessages(loaded)).toBe(loaded.messages.s1);
  });
});

describe('helpers', () => {
  it('filterSessions fuzzy-matches title and path, ranked, and returns all for empty query', () => {
    const sessions = [
      makeSession({ id: 'a', title: 'fix auth token refresh', path: '~/projects/api-server' }),
      makeSession({ id: 'b', title: 'write docs', path: '~/projects/docs' }),
      makeSession({ id: 'c', title: 'auth UI polish', path: '~/projects/web' }),
    ];
    expect(filterSessions(sessions, '')).toHaveLength(3);
    const auth = filterSessions(sessions, 'auth');
    expect(auth.map((s) => s.id).sort()).toEqual(['a', 'c']);
    const byPath = filterSessions(sessions, 'docs');
    expect(byPath.map((s) => s.id)).toEqual(['b']);
    // subsequence match works
    expect(filterSessions(sessions, 'ath').map((s) => s.id).sort()).toEqual(['a', 'c']);
    expect(filterSessions(sessions, 'zzzzz')).toEqual([]);
  });

  it('truncateMiddle shortens long paths keeping both ends', () => {
    const short = '~/projects/x';
    expect(truncateMiddle(short, 40)).toBe(short);
    const long = '~/projects/some/very/deeply/nested/directory/structure/here';
    const out = truncateMiddle(long, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain('…');
    expect(out.startsWith('~/')).toBe(true);
    expect(out.endsWith('here')).toBe(true);
  });

  it('formatRelativeTime buckets times', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5_000, now)).toBe('now');
    expect(formatRelativeTime(now - 90_000, now)).toBe('1m');
    expect(formatRelativeTime(now - 45 * 60_000, now)).toBe('45m');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe('4d');
    // older than a week -> a date string
    const old = formatRelativeTime(now - 30 * 86_400_000, now);
    expect(old).not.toMatch(/^\d+[mhd]$/);
  });
});
