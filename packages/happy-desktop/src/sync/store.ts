/**
 * Zustand vanilla store for the desktop sync core.
 * Holds sessions + per-session messages and derives the DesktopState
 * snapshot (sessions sorted by updatedAt desc, messages seq-asc) that the
 * SyncEngine pushes over IPC after every change.
 */

import { createStore } from 'zustand/vanilla';
import type { DesktopState, MessageView, SessionView } from './types';
import type { NormalizedView } from './normalize';

interface StoreShape {
  status: DesktopState['status'];
  sessions: Record<string, SessionView>;
  messages: Record<string, MessageView[]>;
  error?: string;
}

export interface DesktopStore {
  getSnapshot(): DesktopState;
  subscribe(listener: (snapshot: DesktopState) => void): () => void;
  setStatus(status: DesktopState['status']): void;
  setError(error: string | undefined): void;
  upsertSession(session: SessionView): void;
  /** Upsert many sessions; with prune:true the given set becomes authoritative. */
  upsertSessions(sessions: SessionView[], opts?: { prune?: boolean }): void;
  removeSession(sessionId: string): void;
  setSessionActivity(sessionId: string, activity: { thinking: boolean; active: boolean }): void;
  applyMessages(sessionId: string, views: NormalizedView[]): void;
  dropMessage(sessionId: string, messageId: string): void;
}

function snapshotOf(state: StoreShape): DesktopState {
  const sessions = Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  const out: DesktopState = {
    status: state.status,
    sessions,
    messages: state.messages,
  };
  if (state.error !== undefined) {
    out.error = state.error;
  }
  return out;
}

function insertSorted(list: MessageView[], message: MessageView): void {
  // Binary search by (seq, createdAt, id) — lists stay seq-asc per contract.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const current = list[mid];
    if (
      current.seq < message.seq
      || (current.seq === message.seq && current.createdAt < message.createdAt)
      || (current.seq === message.seq && current.createdAt === message.createdAt && current.id < message.id)
    ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  list.splice(lo, 0, message);
}

export function createDesktopStore(): DesktopStore {
  const store = createStore<StoreShape>()(() => ({
    status: 'connecting',
    sessions: {},
    messages: {},
  }));

  const api: DesktopStore = {
    getSnapshot: () => snapshotOf(store.getState()),

    subscribe: (listener) => store.subscribe((state) => listener(snapshotOf(state))),

    setStatus: (status) => {
      if (store.getState().status !== status) {
        store.setState({ status });
      }
    },

    setError: (error) => {
      if (store.getState().error !== error) {
        store.setState({ error });
      }
    },

    upsertSession: (session) => {
      const sessions = { ...store.getState().sessions };
      const existing = sessions[session.id];
      sessions[session.id] = existing ? { ...existing, ...session } : session;
      store.setState({ sessions });
    },

    upsertSessions: (sessions, opts) => {
      const current = store.getState().sessions;
      const next: Record<string, SessionView> = opts?.prune ? {} : { ...current };
      for (const session of sessions) {
        const existing = current[session.id];
        // Preserve live-only flags (thinking) across server refreshes.
        next[session.id] = existing
          ? { ...session, thinking: session.thinking || existing.thinking }
          : session;
      }
      store.setState({ sessions: next });
    },

    removeSession: (sessionId) => {
      const state = store.getState();
      if (!state.sessions[sessionId] && !state.messages[sessionId]) {
        return;
      }
      const sessions = { ...state.sessions };
      const messages = { ...state.messages };
      delete sessions[sessionId];
      delete messages[sessionId];
      store.setState({ sessions, messages });
    },

    setSessionActivity: (sessionId, activity) => {
      const sessions = { ...store.getState().sessions };
      const existing = sessions[sessionId];
      if (existing) {
        if (existing.thinking === activity.thinking && existing.active === activity.active) {
          return;
        }
        sessions[sessionId] = { ...existing, thinking: activity.thinking, active: activity.active };
      } else {
        sessions[sessionId] = {
          id: sessionId,
          active: activity.active,
          thinking: activity.thinking,
          updatedAt: Date.now(),
          title: `session ${sessionId.slice(0, 6)}`,
          local: false,
          keyAvailable: false,
        };
      }
      store.setState({ sessions });
    },

    applyMessages: (sessionId, views) => {
      if (views.length === 0) {
        return;
      }
      const state = store.getState();
      const current = state.messages[sessionId] ?? [];
      const byId = new Map(current.map((m, i) => [m.id, i]));
      const next = [...current];
      let changed = false;

      for (const { view, stream, localId } of views) {
        // Server echo of an optimistic outbox message replaces the local copy.
        if (localId) {
          const optimisticIndex = byId.get(`local:${localId}`);
          if (optimisticIndex !== undefined) {
            next.splice(optimisticIndex, 1);
            byId.delete(`local:${localId}`);
            // Re-index after removal (indices shifted).
            byId.clear();
            next.forEach((m, i) => byId.set(m.id, i));
            changed = true;
          }
        }

        const existingIndex = byId.get(view.id);
        if (existingIndex !== undefined) {
          const existing = next[existingIndex];
          if (stream?.append) {
            // Stream delta: accumulate text, advance seq, keep original createdAt.
            next[existingIndex] = { ...view, text: existing.text + view.text, createdAt: existing.createdAt };
          } else {
            next[existingIndex] = view;
          }
          changed = true;
          continue;
        }

        insertSorted(next, view);
        byId.clear();
        next.forEach((m, i) => byId.set(m.id, i));
        changed = true;
      }

      if (changed) {
        store.setState({ messages: { ...state.messages, [sessionId]: next } });
      }
    },

    dropMessage: (sessionId, messageId) => {
      const state = store.getState();
      const current = state.messages[sessionId];
      if (!current) {
        return;
      }
      const next = current.filter((m) => m.id !== messageId);
      if (next.length !== current.length) {
        store.setState({ messages: { ...state.messages, [sessionId]: next } });
      }
    },
  };

  return api;
}
