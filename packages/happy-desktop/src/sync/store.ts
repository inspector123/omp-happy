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

      for (const { view, stream, localId, toolResult } of views) {
        // Correlate tool-result with an existing tool-call by (subagentId, callId).
        // Child results only match child calls; root (no subagentId) only matches root.
        if (toolResult) {
          const scope = view.subagentId;
          const matchIdx = next.findIndex(
            (m) =>
              m.kind === 'tool'
              && m.toolData?.callId === toolResult.callId
              && m.subagentId === scope,
          );
          if (matchIdx !== -1) {
            const existing = next[matchIdx];
            next[matchIdx] = {
              ...existing,
              toolData: {
                ...existing.toolData!,
                result: toolResult.result,
                error: toolResult.error,
              },
            };
            changed = true;
          }
          // If no matching call found, skip (don't create orphan result row).
          continue;
        }

        // Server echo of an optimistic outbox message replaces the local copy.
        if (localId) {
          const optimisticIndex = byId.get(`local:${localId}`);
          if (optimisticIndex !== undefined) {
            next.splice(optimisticIndex, 1);
            byId.delete(`local:${localId}`);
            byId.clear();
            next.forEach((m, i) => byId.set(m.id, i));
            changed = true;
          }
        }

        const existingIndex = byId.get(view.id);
        if (existingIndex !== undefined) {
          const existing = next[existingIndex];
          if (stream?.append) {
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

      // Build recursive child tree: nest messages with subagentId under the
      // delegate_task whose task's sessionSubagent matches, at any depth.
      // Handles buffering (child arrives before parent) and grandchild nesting.
      {
        const msgById = new Map(next.map((m) => [m.id, m]));

        // Collect all delegate_task tool messages and their sessionSubagent mapping.
        const delegateMap = new Map<string, string>(); // sessionSubagent -> delegate msg id
        for (const m of next) {
          if (m.kind !== 'tool' || !m.toolData) continue;
          if (m.toolData.name !== 'delegate_task') continue;
          const tasks = (m.toolData.input as Record<string, unknown>)?.tasks;
          if (!Array.isArray(tasks)) continue;
          for (const task of tasks) {
            if (!task || typeof task !== 'object') continue;
            const t = task as Record<string, unknown>;
            const sa = typeof t.sessionSubagent === 'string' ? t.sessionSubagent : undefined;
            if (sa) delegateMap.set(sa, m.id);
          }
        }

        // Recursively find the parent delegate for a subagentId within a scope.
        // scopeChildren: array of message ids already nested under the current delegate.
        function findParentForSubagent(subagentId: string, scopeChildren: string[]): string | null {
          // First check top-level delegates
          if (delegateMap.has(subagentId)) {
            return delegateMap.get(subagentId) ?? null;
          }
          // Then check nested delegates within the current scope
          for (const childId of scopeChildren) {
            const child = msgById.get(childId);
            if (!child || child.kind !== 'tool' || !child.toolData) continue;
            if (child.toolData.name !== 'delegate_task') continue;
            const tasks = (child.toolData.input as Record<string, unknown>)?.tasks;
            if (!Array.isArray(tasks)) continue;
            for (const task of tasks) {
              if (!task || typeof task !== 'object') continue;
              const t = task as Record<string, unknown>;
              const sa = typeof t.sessionSubagent === 'string' ? t.sessionSubagent : undefined;
              if (sa === subagentId) return childId;
              // Recurse into this child's children
              const grandChildren = child.toolData.childMessageIds ?? [];
              const deeper = findParentForSubagent(subagentId, grandChildren);
              if (deeper) return deeper;
            }
          }
          return null;
        }

        // Clear existing childMessageIds to rebuild from scratch.
        for (const m of next) {
          if (m.toolData?.childMessageIds) {
            m.toolData.childMessageIds = [];
          }
        }

        // For each message with a subagentId, find its parent delegate and nest it.
        for (const m of next) {
          if (!m.subagentId) continue;
          const parentId = findParentForSubagent(m.subagentId, []);
          if (!parentId) continue;
          const parent = msgById.get(parentId);
          if (!parent?.toolData) continue;
          if (!parent.toolData.childMessageIds) {
            parent.toolData.childMessageIds = [];
          }
          if (!parent.toolData.childMessageIds.includes(m.id)) {
            parent.toolData.childMessageIds.push(m.id);
            changed = true;
          }
        }
      }

      if (changed || state.messages[sessionId] === undefined) {
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
