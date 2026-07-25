/**
 * Public API of the happy-desktop sync core (pure Node, no electron imports).
 * The contract between the sync slice and the Electron main/preload slices —
 * do not deviate.
 */

export type {
  Credentials,
  SessionKeyInfo,
  SessionView,
  MessageView,
  DesktopState,
  EncryptionVariant,
  SpawnSessionResult,
} from './types';

export { SyncEngine, type SyncEngineOptions } from './syncEngine';

export {
  loadCredentials,
  machineRpcKey,
  readMachineId,
  defaultHappyHomeDir,
  type LoadedCredentials,
  type CredentialEncryption,
} from './credentials';

export {
  readDaemonPort,
  listDaemonSessions,
  stopDaemonSession,
  readPersistedSessionKeys,
  resolveSessionKeys,
  type DaemonChildInfo,
  type ResolvedSessionKeys,
} from './daemonClient';

export { ServerClient } from './serverClient';

export { normalizeDecryptedMessage, summarizeToolCall, type NormalizedView } from './normalize';

export { createDesktopStore, type DesktopStore } from './store';

export {
  encrypt,
  decrypt,
  encryptLegacy,
  decryptLegacy,
  encryptWithDataKey,
  decryptWithDataKey,
  encodeBase64,
  decodeBase64,
  getRandomBytes,
} from './encryption';
