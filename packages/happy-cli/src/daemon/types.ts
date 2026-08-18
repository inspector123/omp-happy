/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface SessionEncryptionData {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

/**
 * Encryption material for a session, as exposed by the daemon control
 * server POST /list endpoint. Consumed by desktop clients to decrypt
 * session content fetched from the server.
 */
export interface ListedSessionEncryption {
  /** base64-encoded session encryption key */
  key: string;
  variant: 'legacy' | 'dataKey';
}

/**
 * Session entry returned by the daemon control server POST /list endpoint.
 */
export interface ListedDaemonSession {
  startedBy: string;
  happySessionId: string;
  pid: number;
  agent?: string;
  tmuxSessionId?: string;
  herdrPaneId?: string;
  path?: string;
  encryption?: ListedSessionEncryption;
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  agent?: string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  encryption?: SessionEncryptionData;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** herdr pane identifier (format: workspace:pane, e.g. w2:p1) */
  herdrPaneId?: string;
}