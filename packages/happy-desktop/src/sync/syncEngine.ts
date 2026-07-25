/**
 * SyncEngine — orchestrates session fetch, live socket updates, message
 * decrypt/normalize, and the outbox. Pure Node (no electron imports); the
 * Electron main process drives it and forwards 'state' events over IPC.
 *
 * Ported behavior:
 * - fetchSessions / fetchMessages v3 paging / outbox POST / socket update
 *   handling: packages/happy-app/sources/sync/sync.ts
 * - user-scoped socket + machineRPC encryption: happy-app apiSocket.ts
 * - key resolution: daemon /list + sessions.json first, then client-side
 *   recovery from server-wrapped keys using the co-located agent credential
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  Credentials,
  DesktopState,
  EncryptionVariant,
  MessageView,
  SessionView,
  SpawnSessionResult,
} from './types';
import { createDesktopStore, type DesktopStore } from './store';
import { normalizeDecryptedMessage, type NormalizedView } from './normalize';
import {
  decodeBase64,
  decrypt,
  deriveContentSecretKey,
  encodeBase64,
  encrypt,
  unwrapDataEncryptionKey,
} from './encryption';
import { readDaemonPort, resolveSessionKeys } from './daemonClient';
import { loadAccountSecret, loadCredentials, machineRpcKey } from './credentials';
import { ServerClient, type RawSessionMessage, type RawSessionRecord } from './serverClient';

/** Mirrors SEQ_BACKWARD_INITIAL_SENTINEL in happy-app sync.ts (int4 max). */
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;
const MESSAGES_PAGE_LIMIT = 100;

interface SessionKey {
  key: Uint8Array;
  variant: EncryptionVariant;
}

export interface SyncEngineOptions {
  serverUrl: string;
  credentials: Credentials;
  daemon?: { port: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export class SyncEngine extends EventEmitter {
  private readonly serverUrl: string;
  private readonly credentials: Credentials;
  private readonly daemonPortOption: number | undefined;
  private readonly store: DesktopStore;
  private readonly server: ServerClient;

  private keys = new Map<string, SessionKey>();
  private localIds = new Set<string>();
  private lastSeq = new Map<string, number>();
  private readonly openSessions = new Set<string>();
  private readonly unsubscribers: (() => void)[] = [];
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts: SyncEngineOptions) {
    super();
    this.serverUrl = opts.serverUrl;
    this.credentials = opts.credentials;
    this.daemonPortOption = opts.daemon?.port;
    this.store = createDesktopStore();
    this.server = new ServerClient({ serverUrl: opts.serverUrl, token: opts.credentials.token });
    this.store.subscribe((snapshot) => this.emit('state', snapshot));
  }

  getState(): DesktopState {
    return this.store.getSnapshot();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.store.setStatus('connecting');

    this.unsubscribers.push(this.server.onUpdate((update) => {
      this.handleUpdate(update).catch((error) => {
        this.store.setError(error instanceof Error ? error.message : String(error));
      });
    }));
    this.unsubscribers.push(this.server.onEphemeral((update) => this.handleEphemeral(update)));
    this.unsubscribers.push(this.server.onStatus((status) => {
      this.store.setStatus(status);
      if (status === 'online') {
        // Initial fetch and every reconnect: full session refresh + resync open sessions.
        this.refreshSessions()
          .then(() => Promise.all([...this.openSessions].map((id) => this.forwardSync(id))))
          .catch((error) => {
            this.store.setError(error instanceof Error ? error.message : String(error));
          });
      }
    }));

    this.server.connect();
    // Safety net: socket events can be missed (server has no connection-state
    // recovery), so poll the session list on a slow interval as a backstop.
    this.pollTimer = setInterval(() => {
      this.refreshSessions().catch(() => undefined);
    }, 30_000);
    // Do the initial fetch eagerly too: if the socket is slow, the session
    // list still renders. Errors here are surfaced but not fatal — the socket
    // reconnect path retries.
    try {
      await this.refreshSessions();
    } catch (error) {
      this.store.setError(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    await this.server.disconnect();
    this.store.setStatus('offline');
  }

  /** Ensure messages for a session are fetched and kept up to date. */
  async openSession(sessionId: string): Promise<void> {
    this.openSessions.add(sessionId);
    if (!this.keys.has(sessionId)) {
      // Key may not be persisted yet (fresh spawn) — re-resolve with a short retry.
      for (let attempt = 0; attempt < 6 && !this.keys.has(sessionId); attempt++) {
        await this.resolveKeys();
        if (!this.keys.has(sessionId)) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 500);
          await promise;
        }
      }
      if (this.keys.has(sessionId)) {
        // Key showed up for a session previously rendered as keyAvailable:false.
        await this.refreshSessions();
      }
    }
    await this.initialFetch(sessionId);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const keyInfo = this.keys.get(sessionId);
    if (!keyInfo) {
      throw new Error(`No encryption key available for session ${sessionId}`);
    }
    const localId = randomUUID();
    const raw = {
      role: 'user',
      content: { type: 'text', text },
      meta: { sentFrom: 'web' },
    };
    const content = encodeBase64(await encrypt(keyInfo.key, keyInfo.variant, raw));

    // Optimistic local copy; the server echo (matching localId) replaces it.
    const seq = (this.lastSeq.get(sessionId) ?? 0) + 1;
    const optimistic: NormalizedView = {
      view: {
        id: `local:${localId}`,
        seq,
        createdAt: Date.now(),
        role: 'user',
        kind: 'text',
        text,
        raw,
      },
    };
    this.store.applyMessages(sessionId, [optimistic]);

    try {
      const posted = await this.server.postMessages(sessionId, [{ localId, content }]);
      let maxSeq = this.lastSeq.get(sessionId) ?? 0;
      for (const message of posted) {
        if (message.seq > maxSeq) maxSeq = message.seq;
      }
      this.lastSeq.set(sessionId, maxSeq);
    } catch (error) {
      this.store.dropMessage(sessionId, `local:${localId}`);
      throw error;
    }
  }

  /**
   * Spawn a session on a machine via machineRPC ('spawn-happy-session' with
   * type 'spawn-in-directory'), params encrypted with the machine key from
   * access.key — the encryption pattern of happy-app apiSocket.machineRPC.
   */
  async spawnSession(machineId: string, directory: string, agent: string): Promise<SpawnSessionResult> {
    const loaded = await loadCredentials(this.credentials.homeDir);
    const { key, variant } = machineRpcKey(loaded);
    const result: unknown = await this.server.machineRPC(
      machineId,
      'spawn-happy-session',
      { type: 'spawn-in-directory', directory, agent },
      key,
      variant,
    );
    // A new-session update will follow; refresh eagerly so the session (and
    // its freshly-persisted key) appears without waiting for the socket.
    this.refreshSessions().catch(() => undefined);

    if (isRecord(result) && result.type === 'success' && typeof result.sessionId === 'string') {
      // The session process takes seconds to boot, register server-side, and
      // persist its encryption key. Poll until it shows up with a key.
      const spawnedId = result.sessionId;
      void (async () => {
        for (let attempt = 0; attempt < 45 && this.started; attempt++) {
          await this.refreshSessions();
          const view = this.getState().sessions.find((s) => s.id === spawnedId);
          if (view?.keyAvailable) {
            return;
          }
          const { promise: delay, resolve: releaseDelay } = Promise.withResolvers<void>();
          setTimeout(releaseDelay, 2_000);
          await delay;
        }
      })().catch(() => undefined);
      return { type: 'success', sessionId: spawnedId };
    }
    if (isRecord(result)) {
      if (result.type === 'requestToApproveDirectoryCreation' && typeof result.directory === 'string') {
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
      }
      if (typeof result.error === 'string') {
        return { type: 'error', errorMessage: result.error };
      }
      if (typeof result.errorMessage === 'string') {
        return { type: 'error', errorMessage: result.errorMessage };
      }
    }
    return { type: 'error', errorMessage: 'Unexpected spawn result' };
  }

  /**
   * Stop an active session through its encrypted session RPC channel.
   * This deliberately does not use the localhost daemon stop endpoint: remote
   * sessions must travel through the server-backed killSession handler.
   */
  async killSession(sessionId: string): Promise<{ success: boolean; message: string }> {
    const session = this.getState().sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!session.active) {
      throw new Error('Session is already stopped');
    }
    const keyInfo = this.keys.get(sessionId);
    if (!keyInfo) {
      throw new Error(`No encryption key available for session ${sessionId}`);
    }

    const result: unknown = await this.server.sessionRPC(
      sessionId,
      'killSession',
      {},
      keyInfo.key,
      keyInfo.variant,
    );
    if (!isRecord(result) || typeof result.success !== 'boolean') {
      throw new Error('Unexpected stop-session response');
    }
    const message = typeof result.message === 'string'
      ? result.message
      : result.success
        ? 'Session stopped'
        : 'Session could not be stopped';
    if (result.success) {
      this.refreshSessions().catch(() => undefined);
    }
    return { success: result.success, message };
  }

  //
  // Internals
  //

  private async resolveKeys(): Promise<Map<string, SessionKey>> {
    const port = this.daemonPortOption ?? await readDaemonPort(this.credentials.homeDir);
    const resolved = await resolveSessionKeys(this.credentials.homeDir, port);
    const localKeys = new Map<string, SessionKey>(
      [...resolved.keys.entries()].map(([id, info]) => [
        id,
        { key: decodeBase64(info.encryptionKey), variant: info.encryptionVariant },
      ]),
    );

    // Retain recovered server keys when openSession is only retrying local key
    // discovery. Local raw keys always overwrite a recovered key for the same
    // session.
    for (const [id, key] of localKeys) {
      this.keys.set(id, key);
    }
    this.localIds = resolved.local;
    return localKeys;
  }

  private async recoverServerKeys(
    records: readonly RawSessionRecord[],
    target: Map<string, SessionKey>,
  ): Promise<void> {
    if (!records.some((record) => !target.has(record.id) && record.dataEncryptionKey)) {
      return;
    }

    const accountSecret = await loadAccountSecret(this.credentials.homeDir);
    if (!accountSecret) {
      return;
    }

    let contentSecretKey: Uint8Array | null = null;
    try {
      contentSecretKey = await deriveContentSecretKey(accountSecret);
      for (const record of records) {
        if (target.has(record.id) || !record.dataEncryptionKey) {
          continue;
        }
        const key = await unwrapDataEncryptionKey(record.dataEncryptionKey, contentSecretKey);
        if (key) {
          target.set(record.id, { key, variant: 'dataKey' });
        }
      }
    } catch {
      // Missing, malformed, or foreign recovery credentials leave only the
      // affected sessions locked; local and legacy keys remain usable.
    } finally {
      accountSecret.fill(0);
      contentSecretKey?.fill(0);
    }
  }

  private refreshSessions(): Promise<void> {
    // Serialize refreshes — socket events may trigger several concurrently.
    // A refresh requested mid-flight marks the run dirty and re-runs after,
    // so a session created during an earlier refresh is never missed.
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      try {
        do {
          this.refreshQueued = false;
          const localKeys = await this.resolveKeys();
          const records = await this.server.listSessions();
          await this.recoverServerKeys(records, localKeys);
          this.keys = localKeys;
          const views: SessionView[] = [];
          for (const record of records) {
            views.push(await this.buildSessionView(record));
          }
          this.store.upsertSessions(views, { prune: true });
        } while (this.refreshQueued);
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  private async decryptFor(sessionId: string, encrypted: string): Promise<unknown | null> {
    const keyInfo = this.keys.get(sessionId);
    if (!keyInfo) {
      return null;
    }
    return decrypt(keyInfo.key, keyInfo.variant, decodeBase64(encrypted));
  }

  private async buildSessionView(record: RawSessionRecord): Promise<SessionView> {
    const keyAvailable = this.keys.has(record.id);
    let title: string | null = null;
    let path: string | undefined;
    let agent: string | undefined;
    let machineId: string | undefined;

    if (keyAvailable) {
      const metadata = record.metadata ? await this.decryptFor(record.id, record.metadata) : null;
      if (isRecord(metadata)) {
        if (isRecord(metadata.summary) && typeof metadata.summary.text === 'string' && metadata.summary.text.length > 0) {
          title = metadata.summary.text;
        }
        if (typeof metadata.path === 'string') path = metadata.path;
        if (typeof metadata.flavor === 'string') agent = metadata.flavor;
        if (typeof metadata.machineId === 'string') machineId = metadata.machineId;
      }
      if (!title && record.lastMessage) {
        const lastRaw = await this.decryptFor(record.id, record.lastMessage.content.c);
        const views = normalizeDecryptedMessage(
          {
            id: record.lastMessage.id,
            localId: record.lastMessage.localId,
            createdAt: record.lastMessage.createdAt,
            seq: record.lastMessage.seq,
          },
          lastRaw,
        );
        const firstUserText = views.find((v) => v.view.role === 'user' && v.view.kind === 'text');
        if (firstUserText) {
          title = truncate(firstUserText.view.text);
        }
      }
    }

    const view: SessionView = {
      id: record.id,
      active: record.active,
      thinking: false, // live flag — the store preserves it across refreshes
      updatedAt: record.updatedAt,
      title: title ?? `session ${record.id.slice(0, 6)}`,
      local: this.localIds.has(record.id),
      keyAvailable,
    };
    if (path !== undefined) view.path = path;
    if (agent !== undefined) view.agent = agent;
    if (machineId !== undefined) view.machineId = machineId;
    return view;
  }

  private async decryptMessages(sessionId: string, messages: RawSessionMessage[]): Promise<NormalizedView[]> {
    const ordered = [...messages].sort((a, b) => a.seq - b.seq);
    const out: NormalizedView[] = [];
    for (const message of ordered) {
      const raw = await this.decryptFor(sessionId, message.content.c);
      if (raw === null) {
        continue;
      }
      const views = normalizeDecryptedMessage(
        { id: message.id, localId: message.localId, createdAt: message.createdAt, seq: message.seq },
        raw,
      );
      for (const view of views) {
        view.localId = message.localId;
        out.push(view);
      }
    }
    return out;
  }

  private async initialFetch(sessionId: string): Promise<void> {
    if (!this.keys.has(sessionId)) {
      return; // keyAvailable:false — ciphertext is never rendered
    }
    const page = await this.server.getMessages(sessionId, {
      beforeSeq: SEQ_BACKWARD_INITIAL_SENTINEL,
      limit: MESSAGES_PAGE_LIMIT,
    });
    const views = await this.decryptMessages(sessionId, page.messages);
    this.store.applyMessages(sessionId, views);
    let maxSeq = this.lastSeq.get(sessionId) ?? 0;
    for (const message of page.messages) {
      if (message.seq > maxSeq) maxSeq = message.seq;
    }
    this.lastSeq.set(sessionId, maxSeq);
    await this.forwardSync(sessionId);
  }

  private async forwardSync(sessionId: string): Promise<void> {
    if (!this.keys.has(sessionId)) {
      return;
    }
    let afterSeq = this.lastSeq.get(sessionId) ?? 0;
    while (true) {
      const page = await this.server.getMessages(sessionId, { afterSeq, limit: MESSAGES_PAGE_LIMIT });
      const views = await this.decryptMessages(sessionId, page.messages);
      this.store.applyMessages(sessionId, views);
      let maxSeq = afterSeq;
      for (const message of page.messages) {
        if (message.seq > maxSeq) maxSeq = message.seq;
      }
      this.lastSeq.set(sessionId, maxSeq);
      if (!page.hasMore || maxSeq === afterSeq) {
        break;
      }
      afterSeq = maxSeq;
    }
  }

  private async handleUpdate(update: unknown): Promise<void> {
    if (!isRecord(update) || !isRecord(update.body) || typeof update.body.t !== 'string') {
      return;
    }
    const body = update.body;
    const createdAt = typeof update.createdAt === 'number' ? update.createdAt : Date.now();

    if (body.t === 'new-message' && typeof body.sid === 'string' && isRecord(body.message)) {
      await this.handleNewMessage(body.sid, body.message, createdAt);
      return;
    }
    if (body.t === 'new-session') {
      await this.refreshSessions();
      return;
    }
    if (body.t === 'delete-session' && typeof body.sid === 'string') {
      this.openSessions.delete(body.sid);
      this.lastSeq.delete(body.sid);
      this.store.removeSession(body.sid);
      return;
    }
    if (body.t === 'update-session' && typeof body.id === 'string') {
      await this.handleUpdateSession(body.id, body, createdAt);
      return;
    }
  }

  private async handleNewMessage(sessionId: string, message: Record<string, unknown>, createdAt: number): Promise<void> {
    if (!this.keys.has(sessionId)) {
      // Unknown or keyless session: a refresh picks up both metadata and keys.
      await this.refreshSessions();
      return;
    }
    const parsed = isRecord(message.content) && message.content.t === 'encrypted' && typeof message.content.c === 'string'
      && typeof message.id === 'string' && typeof message.seq === 'number'
      ? {
        id: message.id,
        seq: message.seq,
        content: { t: 'encrypted' as const, c: message.content.c },
        localId: typeof message.localId === 'string' ? message.localId : null,
        createdAt: typeof message.createdAt === 'number' ? message.createdAt : createdAt,
        updatedAt: createdAt,
      }
      : null;
    if (!parsed) {
      return;
    }

    const raw = await this.decryptFor(sessionId, parsed.content.c);

    // Task lifecycle drives the session thinking flag (mirrors sync.ts).
    let thinking: boolean | null = null;
    if (isRecord(raw) && isRecord(raw.content)) {
      const contentType = raw.content.type;
      const data = isRecord(raw.content.data) ? raw.content.data : null;
      const dataType = data?.type;
      const ev = data && isRecord(data.ev) ? data.ev : null;
      const evType = ev?.t;
      if ((contentType === 'acp' || contentType === 'codex')
        && (dataType === 'task_complete' || dataType === 'turn_aborted')) {
        thinking = false;
      } else if ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') {
        thinking = true;
      } else if (contentType === 'session' && evType === 'turn-end') {
        thinking = false;
      } else if (contentType === 'session' && evType === 'turn-start') {
        thinking = true;
      }
    }

    const current = this.store.getSnapshot().sessions.find((s) => s.id === sessionId);
    if (current) {
      this.store.upsertSession({
        ...current,
        updatedAt: createdAt,
        ...(thinking !== null ? { thinking } : {}),
      });
    } else {
      await this.refreshSessions();
    }

    // Fast path on consecutive seq; a gap triggers a refetch. Messages with
    // seq <= lastSeq are still applied: id-based dedupe makes them an
    // idempotent replace, and a matching localId swaps in the server echo for
    // our optimistic outbox copy.
    const currentLastSeq = this.lastSeq.get(sessionId);
    if (currentLastSeq !== undefined) {
      if (parsed.seq > currentLastSeq + 1) {
        if (this.openSessions.has(sessionId)) {
          await this.forwardSync(sessionId);
        }
      } else {
        const views = await this.decryptMessages(sessionId, [parsed]);
        this.store.applyMessages(sessionId, views);
        if (parsed.seq > currentLastSeq) {
          this.lastSeq.set(sessionId, parsed.seq);
        }
      }
    }
  }

  private async handleUpdateSession(sessionId: string, body: Record<string, unknown>, createdAt: number): Promise<void> {
    const current = this.store.getSnapshot().sessions.find((s) => s.id === sessionId);
    if (!current) {
      await this.refreshSessions();
      return;
    }
    if (!this.keys.has(sessionId)) {
      return;
    }
    const next: SessionView = { ...current, updatedAt: createdAt };
    if (isRecord(body.metadata)
      && typeof body.metadata.version === 'number'
      && typeof body.metadata.value === 'string') {
      const metadata = await this.decryptFor(sessionId, body.metadata.value);
      if (isRecord(metadata)) {
        if (isRecord(metadata.summary) && typeof metadata.summary.text === 'string' && metadata.summary.text.length > 0) {
          next.title = metadata.summary.text;
        }
        if (typeof metadata.path === 'string') next.path = metadata.path;
        if (typeof metadata.flavor === 'string') next.agent = metadata.flavor;
        if (typeof metadata.machineId === 'string') next.machineId = metadata.machineId;
      }
    }
    this.store.upsertSession(next);
  }

  private handleEphemeral(update: unknown): void {
    if (!isRecord(update) || update.type !== 'activity' || typeof update.id !== 'string') {
      return;
    }
    this.store.setSessionActivity(update.id, {
      thinking: update.thinking === true,
      active: update.active === true,
    });
  }
}
