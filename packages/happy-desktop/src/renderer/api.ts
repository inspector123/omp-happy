import { create } from 'zustand';

/**
 * Renderer-side API layer.
 *
 * The renderer talks ONLY to the preload bridge `window.hd`. When the app runs
 * outside Electron (plain browser dev, vitest) the bridge falls back to
 * `window.__HD_MOCK__`, and finally to a built-in rich mock so the UI is
 * demoable standalone.
 *
 * The view types below mirror the sync-core contract exactly
 * (see sync/index.ts); the renderer must not import node code, so the shapes
 * are duplicated here.
 */

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface SessionView {
  id: string;
  active: boolean;
  thinking: boolean;
  updatedAt: number;
  title: string;
  path?: string;
  agent?: string;
  machineId?: string;
  local: boolean;
  keyAvailable: boolean;
}

export interface MessageView {
  id: string;
  seq: number;
  createdAt: number;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'thinking' | 'tool' | 'event';
  text: string;
  raw?: unknown;
}

export interface DesktopState {
  status: ConnectionStatus;
  sessions: SessionView[];
  messages: Record<string, MessageView[]>;
  error?: string;
}

export interface HDBridge {
  getState(): Promise<DesktopState>;
  onState(cb: (s: DesktopState) => void): () => void;
  sendMessage(sessionId: string, text: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
}

declare global {
  interface Window {
    hd?: HDBridge;
    __HD_MOCK__?: HDBridge;
  }
}

// ---------------------------------------------------------------------------
// Bridge resolution
// ---------------------------------------------------------------------------

let bridgeOverride: HDBridge | null = null;
let lazyMock: HDBridge | null = null;

export function getBridge(): HDBridge {
  if (bridgeOverride) return bridgeOverride;
  const g = globalThis as typeof globalThis & Window;
  if (g.hd) return g.hd;
  if (g.__HD_MOCK__) return g.__HD_MOCK__;
  if (!lazyMock) lazyMock = createMockBridge();
  return lazyMock;
}

/** Test seam: force (or clear, with null) the bridge used by the store. */
export function setBridge(b: HDBridge | null): void {
  bridgeOverride = b;
}

let initialized = false;

/** Wire the bridge into the store. Idempotent; called once from main.tsx. */
export async function initBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const b = getBridge();
  b.onState((s) => useDesktop.getState().applyState(s));
  try {
    useDesktop.getState().applyState(await b.getState());
  } catch (e) {
    useDesktop.setState({ error: e instanceof Error ? e.message : String(e), status: 'offline' });
  }
}

// ---------------------------------------------------------------------------
// Mock bridge — realistic standalone demo data with simulated streaming
// ---------------------------------------------------------------------------

export function createMockBridge(opts?: { background?: boolean }): HDBridge {
  const now = Date.now();
  const listeners = new Set<(s: DesktopState) => void>();

  const mk = (
    id: string,
    seq: number,
    role: MessageView['role'],
    kind: MessageView['kind'],
    text: string,
    ageMin: number,
  ): MessageView => ({ id: `${id}-${seq}`, seq, createdAt: now - ageMin * 60_000, role, kind, text });

  const sessions: SessionView[] = [
    {
      id: 's-alpha', active: true, thinking: true, updatedAt: now - 40_000,
      title: 'happy-desktop electron client', path: '~/projects/omp-happy', agent: 'omp',
      machineId: 'devbox', local: true, keyAvailable: true,
    },
    {
      id: 's-beta', active: true, thinking: false, updatedAt: now - 7 * 60_000,
      title: 'fix auth token refresh race', path: '~/projects/api-server', agent: 'claude',
      machineId: 'devbox', local: true, keyAvailable: true,
    },
    {
      id: 's-gamma', active: false, thinking: false, updatedAt: now - 52 * 60_000,
      title: 'draft 0.9.0 release notes', path: '~/projects/happy/docs', agent: 'codex',
      machineId: 'devbox', local: true, keyAvailable: true,
    },
    {
      id: 's-delta', active: false, thinking: false, updatedAt: now - 3 * 3_600_000,
      title: 'phone session · trip planner', path: '~/notes/travel', agent: 'claude',
      machineId: 'pixel-9', local: false, keyAvailable: false,
    },
    {
      id: 's-epsilon', active: false, thinking: false, updatedAt: now - 26 * 3_600_000,
      title: 'refactor sync engine backoff', path: '~/projects/omp-happy/packages/happy-app', agent: 'omp',
      machineId: 'devbox', local: true, keyAvailable: true,
    },
    {
      id: 's-zeta', active: false, thinking: false, updatedAt: now - 4 * 86_400_000,
      title: 'debug flaky e2e: socket reconnect', path: '~/projects/e2e', agent: 'claude',
      machineId: 'ci-runner', local: false, keyAvailable: true,
    },
  ];

  const messages: Record<string, MessageView[]> = {
    's-alpha': [
      mk('s-alpha', 1, 'user', 'text', 'Build a protocol-native Electron desktop client for Happy. Session list on the left, live decrypted messages, message send.', 96),
      mk('s-alpha', 2, 'agent', 'text', 'I scaffolded packages/happy-desktop with electron-vite (main + preload + renderer), React 19, zustand and Tailwind v4. The sync core is pure Node TS so it stays vitest-testable.', 95),
      mk('s-alpha', 3, 'agent', 'thinking', 'Need the daemon /list encryption material before the renderer can decrypt anything…', 94),
      mk('s-alpha', 4, 'agent', 'tool', 'Read packages/happy-cli/src/api/encryption.ts', 94),
      mk('s-alpha', 5, 'agent', 'tool', 'Edit packages/happy-desktop/src/sync/syncEngine.ts', 90),
      mk('s-alpha', 6, 'system', 'event', 'Daemon connected · 6 sessions', 89),
      mk('s-alpha', 7, 'agent', 'text', 'Decryption is working end to end: dataKey AES-GCM records from the server now render as plaintext in the store. 41 unit tests green.', 88),
      mk('s-alpha', 8, 'user', 'text', 'Nice. Wire the renderer to the IPC bridge next, mock-first so it demos standalone.', 42),
      mk('s-alpha', 9, 'agent', 'text', 'On it — zustand store mirrors DesktopState, optimistic composer echo, Cmd+K quick switcher.', 40),
      mk('s-alpha', 10, 'agent', 'thinking', 'Auto-scroll should pin to bottom unless the user scrolled up.', 1),
    ],
    's-beta': [
      mk('s-beta', 1, 'user', 'text', 'Token refresh races when two requests 401 at the same time — we end up logged out.', 400),
      mk('s-beta', 2, 'agent', 'text', 'Root cause: the refresh promise was not memoized, so concurrent 401s each rotated the refresh token. I added a single-flight guard and a regression test.', 390),
      mk('s-beta', 3, 'agent', 'tool', 'Bash pnpm --filter api-server test -- auth.refresh', 389),
      mk('s-beta', 4, 'system', 'event', 'Session resumed on devbox', 380),
      mk('s-beta', 5, 'agent', 'text', 'All 12 auth tests pass. Want me to open the PR?', 379),
    ],
    's-gamma': [
      mk('s-gamma', 1, 'user', 'text', 'Draft release notes for 0.9.0 from the merged PRs this week.', 3000),
      mk('s-gamma', 2, 'agent', 'text', 'Collected 23 merged PRs. Highlights: desktop client alpha, daemon key sharing, socket reconnection fixes. Draft is in docs/releases/0.9.0.md.', 2990),
    ],
    's-delta': [
      mk('s-delta', 1, 'user', 'text', 'Plan a long weekend in Lisbon, walkable neighborhoods only.', 12_000),
    ],
    's-epsilon': [
      mk('s-epsilon', 1, 'user', 'text', 'The sync backoff caps at 30s but never jitters — herd reconnects hammer the server.', 94000 / 60),
      mk('s-epsilon', 2, 'agent', 'text', 'Added full-jitter exponential backoff (base 1s, cap 30s) to apiSocket. Reconnect storms in staging flatten out nicely now.', 1560),
    ],
    's-zeta': [
      mk('s-zeta', 1, 'user', 'text', 'e2e socket-reconnect flake fails ~1 in 20 on CI.', 580_000 / 60),
      mk('s-zeta', 2, 'agent', 'text', 'Tracked it to a race between the heartbeat timeout and the reconnect timer. Fixed by cancelling the heartbeat on transport close.', 576_000 / 60),
    ],
  };

  const state: DesktopState = { status: 'online', sessions, messages };

  let seqCounter = 100;
  function nextSeq(sessionId: string): number {
    const list = state.messages[sessionId] ?? [];
    const max = list.reduce((m, x) => Math.max(m, x.seq), 0);
    seqCounter += 1;
    return Math.max(max + 1, seqCounter);
  }

  function emit(): void {
    state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const snapshot = structuredClone(state);
    for (const l of listeners) l(snapshot);
  }

  function touch(sessionId: string, patch?: Partial<SessionView>): void {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (s) Object.assign(s, { updatedAt: Date.now() }, patch);
  }

  function append(sessionId: string, msg: Omit<MessageView, 'id' | 'seq' | 'createdAt'>): MessageView {
    const full: MessageView = {
      ...msg,
      id: `${sessionId}-live-${seqCounter}`,
      seq: nextSeq(sessionId),
      createdAt: Date.now(),
    };
    (state.messages[sessionId] ??= []).push(full);
    touch(sessionId);
    emit();
    return full;
  }

  const REPLY =
    'Understood. I scanned the relevant code and the fix is straightforward: the renderer now mirrors the full DesktopState, so this reply streamed in token by token over the mock bridge. Selection, unseen dots and the composer all react to live pushes without any Electron code.';

  function streamReply(sessionId: string): void {
    setTimeout(() => {
      touch(sessionId, { thinking: true });
      append(sessionId, { role: 'agent', kind: 'thinking', text: 'Working on a reply…' });
      setTimeout(() => {
        const streamed = append(sessionId, { role: 'agent', kind: 'text', text: '' });
        const tokens = REPLY.split(' ');
        let i = 0;
        const timer = setInterval(() => {
          i += 1;
          streamed.text = tokens.slice(0, i).join(' ');
          touch(sessionId, { thinking: true });
          emit();
          if (i >= tokens.length) {
            clearInterval(timer);
            touch(sessionId, { thinking: false });
            emit();
          }
        }, 90);
      }, 700);
    }, 500);
  }

  if (opts?.background !== false) {
    // Background chatter on other sessions so unseen dots / re-sorting demo themselves.
    const CHATTER = [
      'CI is green on the latest push.',
      'Found the root cause — writing a regression test now.',
      'Updated the draft with your feedback.',
      'Restarted the worker; watching the logs.',
    ];
    let idx = 0;
    setInterval(() => {
      const candidates = state.sessions.filter((s) => s.keyAvailable);
      if (!candidates.length) return;
      const target = candidates[idx++ % candidates.length];
      append(target.id, { role: 'agent', kind: 'text', text: CHATTER[idx % CHATTER.length] });
    }, 11_000);
  }

  return {
    async getState() {
      return structuredClone(state);
    },
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async sendMessage(sessionId, text) {
      const target = state.sessions.find((s) => s.id === sessionId);
      if (!target) throw new Error(`unknown session ${sessionId}`);
      if (!target.keyAvailable) throw new Error('session is encrypted: no key available');
      append(sessionId, { role: 'user', kind: 'text', text });
      streamReply(sessionId);
    },
    async openSession() {
      // mock always has every message loaded
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (exported for components + tests)
// ---------------------------------------------------------------------------

export function normalizeMessages(list: MessageView[]): MessageView[] {
  const seen = new Set<string>();
  const out: MessageView[] = [];
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function truncateMiddle(s: string, max = 42): string {
  if (s.length <= max) return s;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Subsequence fuzzy score; higher is better, null when query is not a subsequence. */
function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 1 + streak * 2;
    if (ci === 0 || c[ci - 1] === ' ' || c[ci - 1] === '/' || c[ci - 1] === '-' || c[ci - 1] === '_') score += 4;
    qi += 1;
  }
  if (qi < q.length) return null;
  return score - c.length * 0.01; // prefer shorter candidates on ties
}

export function filterSessions(sessions: SessionView[], query: string): SessionView[] {
  const q = query.trim();
  if (!q) return sessions;
  const scored: Array<{ s: SessionView; score: number }> = [];
  for (const s of sessions) {
    const title = fuzzyScore(q, s.title);
    const path = s.path ? fuzzyScore(q, s.path) : null;
    const best = Math.max(title ?? -Infinity, path !== null ? path * 0.9 : -Infinity);
    if (best > -Infinity) scored.push({ s, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s);
}

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Renderer store
// ---------------------------------------------------------------------------

export interface RendererStore {
  status: ConnectionStatus;
  sessions: SessionView[];
  messages: Record<string, MessageView[]>;
  error?: string;
  hydrated: boolean;
  selectedSessionId: string | null;
  unseen: Record<string, true>;
  switcherOpen: boolean;

  applyState(s: DesktopState): void;
  selectSession(id: string): void;
  cycleSelection(delta: 1 | -1): void;
  selectByIndex(i: number): void;
  toggleSwitcher(open?: boolean): void;
  send(text: string): Promise<void>;
}

let optimisticCounter = 0;

const NO_MESSAGES: MessageView[] = [];

/**
 * Store selector for the selected session's messages. MUST return a cached
 * reference when the underlying state is unchanged — useSyncExternalStore
 * re-reads the snapshot on every render and loops (React #185) otherwise.
 */
export function selectSelectedMessages(s: RendererStore): MessageView[] {
  return s.selectedSessionId ? (s.messages[s.selectedSessionId] ?? NO_MESSAGES) : NO_MESSAGES;
}

export const useDesktop = create<RendererStore>()((set, get) => {
  function applySelection(id: string | null): void {
    if (!id) return;
    set((prev) => {
      if (!prev.sessions.some((s) => s.id === id)) return prev;
      const unseen = { ...prev.unseen };
      delete unseen[id];
      return { selectedSessionId: id, unseen };
    });
    void getBridge()
      .openSession(id)
      .catch((e) => set({ error: e instanceof Error ? e.message : String(e) }));
  }

  return {
    status: 'connecting',
    sessions: [],
    messages: {},
    error: undefined,
    hydrated: false,
    selectedSessionId: null,
    unseen: {},
    switcherOpen: false,

    applyState(s) {
      set((prev) => {
        const messages: Record<string, MessageView[]> = {};
        for (const [sid, list] of Object.entries(s.messages)) {
          const incoming = normalizeMessages(list);
          // Reconcile optimistic echoes: drop local-* placeholders once the
          // engine delivers the real user message with the same text.
          const realUserTexts = new Set(incoming.filter((m) => m.role === 'user').map((m) => m.text));
          const pending = (prev.messages[sid] ?? []).filter(
            (m) => m.id.startsWith('local-') && !incoming.some((x) => x.id === m.id) && !realUserTexts.has(m.text),
          );
          messages[sid] = pending.length ? normalizeMessages([...incoming, ...pending]) : incoming;
        }

        let selectedSessionId = prev.selectedSessionId;
        const unseen = { ...prev.unseen };

        if (!prev.hydrated) {
          // First state: pick the most recent session, nothing counts as unseen.
          if (!selectedSessionId || !s.sessions.some((x) => x.id === selectedSessionId)) {
            selectedSessionId = s.sessions[0]?.id ?? null;
          }
        } else {
          const prevUpdated = new Map(prev.sessions.map((x) => [x.id, x.updatedAt] as const));
          for (const sess of s.sessions) {
            if (sess.id === selectedSessionId) continue;
            const before = prevUpdated.get(sess.id);
            if (before === undefined || sess.updatedAt > before) unseen[sess.id] = true;
          }
          if (selectedSessionId) delete unseen[selectedSessionId];
          if (selectedSessionId && !s.sessions.some((x) => x.id === selectedSessionId)) {
            selectedSessionId = s.sessions[0]?.id ?? null;
            if (selectedSessionId) delete unseen[selectedSessionId];
          }
        }

        return {
          status: s.status,
          sessions: s.sessions,
          messages,
          error: s.error,
          hydrated: true,
          selectedSessionId,
          unseen,
        };
      });
    },

    selectSession(id) {
      applySelection(id);
    },

    cycleSelection(delta) {
      const { sessions, selectedSessionId } = get();
      if (!sessions.length) return;
      const idx = sessions.findIndex((s) => s.id === selectedSessionId);
      const next = sessions[(idx + delta + sessions.length) % sessions.length];
      applySelection(next.id);
    },

    selectByIndex(i) {
      const { sessions } = get();
      const target = sessions[i];
      if (target) applySelection(target.id);
    },

    toggleSwitcher(open) {
      set((prev) => ({ switcherOpen: open ?? !prev.switcherOpen }));
    },

    async send(text) {
      const trimmed = text.trim();
      const { status, selectedSessionId } = get();
      if (!trimmed || !selectedSessionId || status === 'offline') return;

      optimisticCounter += 1;
      const optimistic: MessageView = {
        id: `local-${optimisticCounter}`,
        seq: (get().messages[selectedSessionId] ?? []).reduce((m, x) => Math.max(m, x.seq), 0) + 1,
        createdAt: Date.now(),
        role: 'user',
        kind: 'text',
        text: trimmed,
      };
      set((prev) => ({
        error: undefined,
        messages: {
          ...prev.messages,
          [selectedSessionId]: normalizeMessages([...(prev.messages[selectedSessionId] ?? []), optimistic]),
        },
      }));

      try {
        await getBridge().sendMessage(selectedSessionId, trimmed);
      } catch (e) {
        set((prev) => ({
          error: e instanceof Error ? e.message : String(e),
          messages: {
            ...prev.messages,
            [selectedSessionId]: (prev.messages[selectedSessionId] ?? []).filter((m) => m.id !== optimistic.id),
          },
        }));
      }
    },
  };
});
