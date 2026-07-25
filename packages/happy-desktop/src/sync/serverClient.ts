/**
 * Server client for the desktop sync core: user-scoped REST (fetch) plus the
 * socket.io /v1/updates channel. Mirrors happy-app's apiSocket.ts
 * (user-scoped connect, rpc-call encryption for machineRPC) and the REST
 * calls in sync.ts (fetchSessions / fetchMessages v3 / outbox POST).
 */

import { io, type Socket } from 'socket.io-client';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import type { EncryptionVariant } from './types';

export interface RawSessionMessage {
  id: string;
  seq: number;
  content: { t: 'encrypted'; c: string };
  localId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RawSessionRecord {
  id: string;
  tag: string | null;
  seq: number;
  metadata: string;
  metadataVersion: number;
  agentState: string | null;
  agentStateVersion: number;
  dataEncryptionKey: string | null;
  active: boolean;
  activeAt: number;
  createdAt: number;
  updatedAt: number;
  lastMessage: RawSessionMessage | null;
}

export interface MessagesPage {
  messages: RawSessionMessage[];
  hasMore: boolean;
}

export interface PostedMessage {
  id: string;
  seq: number;
  localId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type UpdateHandler = (update: unknown) => void;
export type StatusHandler = (status: 'connecting' | 'online' | 'offline') => void;

export interface ServerClientOptions {
  serverUrl: string;
  token: string;
  /** Defaults to happy-desktop/<version> — mirrors getHappyClientId(). */
  happyClient?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMessage(value: unknown): RawSessionMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.seq !== 'number') {
    return null;
  }
  if (!isRecord(value.content) || value.content.t !== 'encrypted' || typeof value.content.c !== 'string') {
    return null;
  }
  return {
    id: value.id,
    seq: value.seq,
    content: { t: 'encrypted', c: value.content.c },
    localId: typeof value.localId === 'string' ? value.localId : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

export class ServerClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly happyClient: string;
  private socket: Socket | null = null;
  private updateHandlers = new Set<UpdateHandler>();
  private ephemeralHandlers = new Set<UpdateHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private status: 'connecting' | 'online' | 'offline' = 'offline';

  constructor(opts: ServerClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.happyClient = opts.happyClient ?? 'happy-desktop/0.0.1';
  }

  //
  // REST
  //

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-Happy-Client': this.happyClient,
    };
  }

  async listSessions(): Promise<RawSessionRecord[]> {
    const response = await fetch(`${this.serverUrl}/v1/sessions`, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Failed to fetch sessions: ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.sessions)) {
      return [];
    }
    const sessions: RawSessionRecord[] = [];
    for (const value of body.sessions) {
      if (!isRecord(value) || typeof value.id !== 'string') {
        continue;
      }
      sessions.push({
        id: value.id,
        tag: typeof value.tag === 'string' ? value.tag : null,
        seq: typeof value.seq === 'number' ? value.seq : 0,
        metadata: typeof value.metadata === 'string' ? value.metadata : '',
        metadataVersion: typeof value.metadataVersion === 'number' ? value.metadataVersion : 0,
        agentState: typeof value.agentState === 'string' ? value.agentState : null,
        agentStateVersion: typeof value.agentStateVersion === 'number' ? value.agentStateVersion : 0,
        dataEncryptionKey: typeof value.dataEncryptionKey === 'string' ? value.dataEncryptionKey : null,
        active: value.active === true,
        activeAt: typeof value.activeAt === 'number' ? value.activeAt : 0,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
        lastMessage: parseMessage(value.lastMessage),
      });
    }
    return sessions;
  }

  async getMessages(
    sessionId: string,
    opts: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): Promise<MessagesPage> {
    const params = new URLSearchParams();
    if (opts.afterSeq !== undefined) params.set('after_seq', String(opts.afterSeq));
    if (opts.beforeSeq !== undefined) params.set('before_seq', String(opts.beforeSeq));
    params.set('limit', String(opts.limit ?? 100));
    const response = await fetch(
      `${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages?${params}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch messages for ${sessionId}: ${response.status}`);
    }
    const body: unknown = await response.json();
    const messages: RawSessionMessage[] = [];
    if (isRecord(body) && Array.isArray(body.messages)) {
      for (const value of body.messages) {
        const parsed = parseMessage(value);
        if (parsed) messages.push(parsed);
      }
    }
    return { messages, hasMore: isRecord(body) && body.hasMore === true };
  }

  async postMessages(sessionId: string, messages: { localId: string; content: string }[]): Promise<PostedMessage[]> {
    const response = await fetch(`${this.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messages }),
    });
    if (!response.ok) {
      throw new Error(`Failed to send messages for ${sessionId}: ${response.status}`);
    }
    const body: unknown = await response.json();
    const posted: PostedMessage[] = [];
    if (isRecord(body) && Array.isArray(body.messages)) {
      for (const value of body.messages) {
        if (isRecord(value) && typeof value.id === 'string' && typeof value.seq === 'number') {
          posted.push({
            id: value.id,
            seq: value.seq,
            localId: typeof value.localId === 'string' ? value.localId : null,
            createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
            updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
          });
        }
      }
    }
    return posted;
  }

  //
  // Socket (user-scoped, /v1/updates)
  //

  onUpdate(handler: UpdateHandler): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  onEphemeral(handler: UpdateHandler): () => void {
    this.ephemeralHandlers.add(handler);
    return () => this.ephemeralHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: 'connecting' | 'online' | 'offline'): void {
    if (this.status !== status) {
      this.status = status;
      for (const handler of this.statusHandlers) handler(status);
    }
  }

  connect(): void {
    if (this.socket) {
      return;
    }
    this.setStatus('connecting');
    this.socket = io(this.serverUrl, {
      path: '/v1/updates',
      auth: {
        token: this.token,
        clientType: 'user-scoped' as const,
        happyClient: this.happyClient,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });
    this.socket.on('connect', () => this.setStatus('online'));
    this.socket.on('disconnect', () => this.setStatus('offline'));
    this.socket.on('connect_error', () => this.setStatus('offline'));
    this.socket.on('update', (data: unknown) => {
      for (const handler of this.updateHandlers) handler(data);
    });
    this.socket.on('ephemeral', (data: unknown) => {
      for (const handler of this.ephemeralHandlers) handler(data);
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    this.setStatus('offline');
  }

  /**
   * sessionRPC: params and results are encrypted with the session-specific key.
   * This is the same rpc-call transport used by happy-app's apiSocket.sessionRPC.
   */
  async sessionRPC<R = unknown>(
    sessionId: string,
    method: string,
    params: unknown,
    key: Uint8Array,
    variant: EncryptionVariant,
  ): Promise<R> {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    const encryptedParams = encodeBase64(await encrypt(key, variant, params));
    const result: unknown = await this.socket.timeout(30_000).emitWithAck('rpc-call', {
      method: `${sessionId}:${method}`,
      params: encryptedParams,
    });
    if (isRecord(result) && result.ok === true && typeof result.result === 'string') {
      const decrypted = await decrypt(key, variant, decodeBase64(result.result));
      return decrypted as R;
    }
    const message = isRecord(result) && typeof result.error === 'string' ? result.error : 'RPC call failed';
    throw new Error(message);
  }

  /**
   * machineRPC: params encrypted with the machine's encryption key exactly as
   * happy-app's apiSocket.machineRPC does — the daemon's RpcHandlerManager
   * decrypts with the same key (access.key machineKey for dataKey creds).
   */
  async machineRPC<R = unknown>(
    machineId: string,
    method: string,
    params: unknown,
    key: Uint8Array,
    variant: EncryptionVariant,
  ): Promise<R> {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    const encryptedParams = encodeBase64(await encrypt(key, variant, params));
    const result: unknown = await this.socket.timeout(30_000).emitWithAck('rpc-call', {
      method: `${machineId}:${method}`,
      params: encryptedParams,
    });
    if (isRecord(result) && result.ok === true && typeof result.result === 'string') {
      const decrypted = await decrypt(key, variant, decodeBase64(result.result));
      return decrypted as R;
    }
    const message = isRecord(result) && typeof result.error === 'string' ? result.error : 'RPC call failed';
    throw new Error(message);
  }
}
