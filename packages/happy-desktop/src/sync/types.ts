/**
 * Shared contract types for the happy-desktop sync core.
 * These shapes are the public API of src/sync (re-exported from index.ts).
 * Do not deviate — the Electron main/preload/renderer slices code against them.
 */

export interface Credentials {
  token: string;
  homeDir: string;
}

export interface SessionKeyInfo {
  sessionId: string;
  encryptionKey: string /* base64 */;
  encryptionVariant: 'legacy' | 'dataKey';
}

export interface SessionView {
  id: string;
  active: boolean;
  thinking: boolean;
  updatedAt: number;
  title: string;          // from decrypted metadata summary/first user msg, fallback 'session <id6>'
  path?: string;
  agent?: string;
  machineId?: string;
  local: boolean;         // true if reported by local daemon /list
  keyAvailable: boolean;  // false => render as "encrypted (no key)"
}

export interface MessageView {
  id: string;
  seq: number;
  createdAt: number;
  role: 'user' | 'agent' | 'system';
  kind: 'text' | 'thinking' | 'tool' | 'event';
  text: string;           // rendered plaintext (tool => summary line)
  raw?: unknown;          // decrypted payload for future rich renderers
}

export interface DesktopState {
  status: 'connecting' | 'online' | 'offline';
  sessions: SessionView[];                 // sorted by updatedAt desc
  messages: Record<string, MessageView[]>; // keyed by sessionId, seq-asc
  error?: string;
}

export type EncryptionVariant = 'legacy' | 'dataKey';

/** Result of a machineRPC 'spawn-happy-session' call (mirrors happy-cli's SpawnSessionResult). */
export type SpawnSessionResult =
  | { type: 'success'; sessionId: string }
  | { type: 'requestToApproveDirectoryCreation'; directory: string }
  | { type: 'error'; errorMessage: string };
