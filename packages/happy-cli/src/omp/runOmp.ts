import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

import { spawn as spawnPty, type IPty } from 'node-pty';
import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type SessionEvent } from '@slopus/happy-wire';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { projectPath } from '@/projectPath';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { createOmpConfigCommandRunner, persistOmpDefaultModel } from './ompModelConfig';

const KEEPALIVE_INTERVAL_MS = 2_000;
const MIRROR_FLUSH_DELAY_MS = 150;
const BRIDGE_READY_TIMEOUT_MS = 15_000;
const PTY_PROMPT_SETTLE_MS = 120;
const PTY_PROMPT_MAX_CHARS = 2_048;
const EXPLICIT_SUDO_PROMPT_PATTERN = /(?:\[sudo\]|sudo:)\s*password(?:\s+for\s+[^:\r\n]+)?:/i;
const TRAILING_PASSWORD_PROMPT_PATTERN = /(?:^|\n)(?:\[[^\]\r\n]+\]\s*)?password(?:\s+for\s+[^:\r\n]+)?:\s*$/i;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const BRIDGE_EXIT_GRACE_MS = 300;
const BRIDGE_SOCKET_ENV = 'OMP_HAPPY_BRIDGE_SOCKET';
const BRIDGE_CONTROL_MODE_ENV = 'OMP_HAPPY_CONTROL_MODE';
const BRIDGE_EXTENSION_FILE = 'omp-happy-bridge.mjs';
// Overlay that pins autoResume off for Happy-managed spawns so every chat
// mints a fresh OMP transcript (and thus a unique ompSessionId) regardless
// of the host's global omp settings. Passed after user extra args so it wins.
const CONFIG_OVERLAY_FILE = 'omp-happy-config.overlay.yml';
const MAX_BUFFERED_CHILD_EVENTS = 256;
const MAX_CHILD_TEXT_CHARS = 256 * 1024;
const MAX_SEEN_CHILD_MESSAGES = 128;
const ROOT_BRIDGE_KEY = '$root';

type RunMode = 'local' | 'remote';

type BridgeFrame = BridgeReadyFrame | BridgeAgentEventFrame | BridgeSubagentLifecycleFrame | BridgeInputFrame | BridgeErrorFrame | BridgeAbortedFrame | BridgeAskRequestFrame | BridgeChangeTitleFrame | BridgeTuiCommandReadyFrame;

type BridgeReadyFrame = {
  type: 'ready';
  protocolVersion: number;
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  models?: Array<{ code: string; value: string; description?: string }>;
  currentModel?: string;
  thoughtLevels?: Array<{ code: string; value: string; description?: string }>;
  currentThoughtLevel?: string;
  title?: string;
};

type BridgeAgentEventFrame = {
  type: 'agent_event';
  event: MirrorEvent;
};

type BridgeSubagentLifecycleFrame = {
  type: 'subagent_lifecycle';
  payload: {
    id: unknown;
    parentToolCallId: unknown;
    index: unknown;
    status: unknown;
    sessionFile?: unknown;
    detached?: unknown;
  };
};

type BridgeInputFrame = {
  type: 'input';
  text: string;
  source: 'interactive' | 'rpc' | 'extension';
};

type BridgeErrorFrame = {
  type: 'bridge_error';
  message: string;
};

type BridgeAbortedFrame = {
  type: 'aborted';
};

type BridgeAskRequestFrame = {
  type: 'ask_request';
  id: string;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multi?: boolean;
    recommended?: number;
  }>;
};

type BridgeChangeTitleFrame = {
  type: 'change_title';
  title: string;
};

type BridgeTuiCommandReadyFrame = {
  type: 'tui_command_ready';
  command: string;
};

type PendingPtyPrompt = {
  id: string;
  callId?: string;
};

type PhoneAttachment = {
  data: Uint8Array;
  mimeType: string;
  name: string;
};

type MirrorEvent = {
  type: string;
  message?: unknown;
  assistantMessageEvent?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: unknown;
  level?: unknown;
};

type BridgeFrameSource = {
  readonly connectionId: number;
  primary: boolean;
  sessionId?: string;
  childRegistryName?: string;
};

type DelegateTaskBinding = {
  callId: string;
  parentBridgeKey: string;
  taskIndex: number;
  taskName: string;
  sessionSubagent: string;
  registryName?: string;
  source?: BridgeFrameSource;
  started: boolean;
  completed: boolean;
};

type ChildMirrorState = {
  source: BridgeFrameSource;
  binding?: DelegateTaskBinding;
  bufferedFrames: Array<BridgeAgentEventFrame | BridgeSubagentLifecycleFrame>;
  eligibleBindings: Set<DelegateTaskBinding>;
  parentRegistryName?: string;
  discarded: boolean;
  pendingText: string;
  pendingThinking: string;
  messageOpen: boolean;
  lastText: string;
  lastThinking: string;
  seenMessageIds: Set<string>;
  toolCallIds: Map<string, string>;
  completedToolCalls: Set<string>;
  stopped: boolean;
};

export interface RunOmpOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  yolo?: boolean;
  extraArgs?: string[];
}

interface BridgeServer {
  send(frame: unknown): boolean;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeBridgeToolName(toolName: string): string {
  switch (toolName) {
    case 'bash':
    case 'shell':
      return 'execute';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'write':
      return 'Write';
    // Native OMP tools use lowercase names, while the app's compact cards
    // are keyed by the established Happy tool identities.
    case 'todo':
      return 'TodoWrite';
    case 'task':
      return 'delegate_task';
    case 'browser':
      return 'fetch';
    default:
      return toolName;
  }
}


function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/\r/g, '\n')
    .replace(/\u0008/g, '');
}

function detectExplicitSudoPasswordPrompt(value: string): string | null {
  const match = EXPLICIT_SUDO_PROMPT_PATTERN.exec(stripTerminalControlSequences(value));
  return match?.[0].trim() ?? null;
}

function detectTrailingPasswordPrompt(value: string): string | null {
  const match = TRAILING_PASSWORD_PROMPT_PATTERN.exec(stripTerminalControlSequences(value));
  return match?.[0].trim() ?? null;
}
function normalizeBridgeToolInput(toolName: string, input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  if (
    toolName === 'Glob'
    && typeof input.path === 'string'
    && typeof input.pattern !== 'string'
  ) {
    return { ...input, pattern: input.path };
  }
  if (
    toolName === 'Write'
    && typeof input.path === 'string'
    && typeof input.file_path !== 'string'
  ) {
    return { ...input, file_path: input.path };
  }
  if (toolName === 'TodoWrite' && !Array.isArray(input.todos) && Array.isArray(input.items)) {
    return { ...input, todos: input.items };
  }
  if (toolName === 'delegate_task' && Array.isArray(input.tasks)) {
    const tasks = input.tasks.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      const id = asString(entry.id) ?? asString(entry.name) ?? `task-${index + 1}`;
      const description = asString(entry.description) ?? asString(entry.task) ?? id;
      const role = asString(entry.role) ?? asString(entry.agent);
      return [{ ...entry, id, description, ...(role ? { role } : {}) }];
    });
    return { ...input, tasks };
  }
  if (toolName === 'delegate_task' && !Array.isArray(input.tasks)) {
    const description = asString(input.prompt) ?? asString(input.description);
    if (description) {
      return { ...input, tasks: [{ id: 'task-1', description }] };
    }
  }
  if (toolName === 'fetch' && typeof input.url !== 'string' && typeof input.uri === 'string') {
    return { ...input, url: input.uri };
  }
  return input;
}


function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isAssistantMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'assistant';
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'user';
}
function extractAdvisorNotes(message: unknown): Array<{ note: string; severity?: 'nit' | 'concern' | 'blocker'; advisor?: string }> {
  if (!isRecord(message) || message.role !== 'custom' || message.customType !== 'advisor' || message.display !== true || !isRecord(message.details)) {
    return [];
  }
  const notes = message.details.notes;
  if (!Array.isArray(notes)) {
    return [];
  }
  return notes.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.note !== 'string' || entry.note.trim().length === 0) {
      return [];
    }
    const severity = entry.severity;
    if (severity !== undefined && severity !== 'nit' && severity !== 'concern' && severity !== 'blocker') {
      return [];
    }
    const advisor = entry.advisor;
    if (advisor !== undefined && typeof advisor !== 'string') {
      return [];
    }
    return [{ note: entry.note, ...(severity === undefined ? {} : { severity }), ...(advisor === undefined ? {} : { advisor }) }];
  });
}


function extractMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return '';
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('');
}

function appendBoundedChildText(current: string, addition: string): string {
  const remaining = MAX_CHILD_TEXT_CHARS - current.length;
  return remaining > 0 ? current + addition.slice(0, remaining) : current;
}

function extractChildMessageParts(message: unknown): { text: string; thinking: string } {
  if (!isRecord(message)) {
    return { text: '', thinking: '' };
  }
  const content = message.content;
  if (typeof content === 'string') {
    return { text: content.slice(0, MAX_CHILD_TEXT_CHARS), thinking: '' };
  }
  if (!Array.isArray(content)) {
    return { text: '', thinking: '' };
  }
  let text = '';
  let thinking = '';
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text = appendBoundedChildText(text, block.text);
      continue;
    }
    if (block.type === 'thinking') {
      const value = asString(block.thinking) ?? asString(block.text);
      if (value) thinking = appendBoundedChildText(thinking, value);
    }
  }
  return { text, thinking };
}

function extractToolError(result: unknown, isErrorFlag?: unknown): boolean {
  if (isErrorFlag === true) {
    return true;
  }
  return isRecord(result) && (result.isError === true || typeof result.error === 'string');
}


function extractTodoEntries(result: unknown): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> {
  const directPhases = isRecord(result) ? result.phases : undefined;
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  const phases = Array.isArray(directPhases) ? directPhases : details?.phases;
  if (!Array.isArray(phases)) {
    return [];
  }
  return phases.flatMap((phase) => {
    const items = isRecord(phase) && Array.isArray(phase.items)
      ? phase.items
      : isRecord(phase) && Array.isArray(phase.tasks) ? phase.tasks : undefined;
    if (!items) {
      return [];
    }
    return items.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const content = asString(item.content) ?? asString(item.text);
      const status = asString(item.status);
      if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
        return [];
      }
      return [{ content, status }];
    });
  });
}

function buildOmpArgs(opts: RunOmpOptions, extensionPath: string, configOverlayPath: string): string[] {
  const extraArgs = (opts.extraArgs ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0 && value !== 'undefined',
  );
  const args = ['--allow-home', '--extension', extensionPath, ...extraArgs, '--config', configOverlayPath];
  if (opts.yolo && !args.includes('--auto-approve') && !args.includes('--approval-mode')) {
    args.unshift('--auto-approve');
  }
  return args;
}

function getSessionRegistryName(sessionFile: unknown): string | undefined {
  if (typeof sessionFile !== 'string' || sessionFile.length === 0) {
    return undefined;
  }
  const registryName = basename(sessionFile, extname(sessionFile));
  return registryName && registryName !== '.' && registryName !== '..' ? registryName : undefined;
}

async function startBridgeServer(
  socketPath: string,
  onFrame: (frame: BridgeFrame, source: BridgeFrameSource) => void,
  onDisconnect: (source: BridgeFrameSource) => void,
  log: (message: string, data?: unknown) => void,
): Promise<BridgeServer> {
  type BridgeConnection = BridgeFrameSource & {
    pending: string;
  };

  const connections = new Map<Socket, BridgeConnection>();
  let nextConnectionId = 1;
  let primarySessionId: string | null = null;
  let primarySocket: Socket | null = null;
  const outgoing: string[] = [];

  const flushOutgoing = (socket: Socket): void => {
    if (!socket.writable) return;
    for (const line of outgoing.splice(0)) socket.write(line);
  };

  const processLine = (line: string, socket: Socket): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const frame = JSON.parse(trimmed) as BridgeFrame;
      const connection = connections.get(socket);
      if (!connection) return;

      if (frame.type === 'ready') {
        connection.sessionId = frame.sessionId;
        const reconnectsPrimary = primarySessionId !== null && frame.sessionId === primarySessionId;
        const establishesPrimary = primarySessionId === null;
        if (primarySocket === socket || reconnectsPrimary || establishesPrimary) {
          primarySessionId = frame.sessionId;
          primarySocket = socket;
          connection.primary = true;
          connection.childRegistryName = undefined;
          flushOutgoing(socket);
        } else {
          connection.primary = false;
          connection.childRegistryName = getSessionRegistryName(frame.sessionFile);
          if (!connection.childRegistryName) {
            log(`Ignoring OMP child bridge session ${frame.sessionId} without a session file name`);
          }
        }
        onFrame(frame, connection);
        return;
      }

      if (
        connection.primary
        || (
          connection.childRegistryName
          && (frame.type === 'agent_event' || frame.type === 'subagent_lifecycle')
        )
      ) {
        onFrame(frame, connection);
      }
    } catch (error) {
      log(`Failed to parse OMP bridge frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const server: Server = createServer((socket) => {
    const connection: BridgeConnection = {
      connectionId: nextConnectionId,
      primary: false,
      pending: '',
    };
    nextConnectionId += 1;
    connections.set(socket, connection);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      connection.pending += chunk;
      const lines = connection.pending.split('\n');
      connection.pending = lines.pop() ?? '';
      for (const line of lines) processLine(line, socket);
    });
    socket.on('close', () => {
      connections.delete(socket);
      if (primarySocket === socket) primarySocket = null;
      onDisconnect(connection);
    });
    socket.on('error', (error) => {
      log(`OMP bridge socket error: ${error.message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  return {
    send(frame: unknown): boolean {
      const line = `${JSON.stringify(frame)}\n`;
      if (primarySocket?.writable) primarySocket.write(line);
      else outgoing.push(line);
      return true;
    },
    async close(): Promise<void> {
      for (const socket of connections.keys()) socket.destroy();
      connections.clear();
      primarySocket = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function runOmp(opts: RunOmpOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('omp');

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'omp',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
  });
  const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
  const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
  const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;

  let response: ApiSession | null;
  if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
    logger.debug(`[happy-omp] Reconnecting to existing session ${reconnectSessionId}`);
    response = {
      id: reconnectSessionId,
      seq: Number.parseInt(process.env.HAPPY_RECONNECT_SEQ || '0', 10),
      encryptionKey: decodeBase64(reconnectKeyBase64),
      encryptionVariant: reconnectVariant,
      metadata,
      metadataVersion: Number.parseInt(process.env.HAPPY_RECONNECT_METADATA_VERSION || '0', 10),
      agentState: state,
      agentStateVersion: Number.parseInt(process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION || '0', 10),
    };
  } else {
    response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  }
  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[happy-omp] Failed to report session to daemon:', error);
    }
  }

  let child: IPty | null = null;
  let shouldExit = false;
  let archiveOnExit = false;
  let turnStarted = false;
  let abortInProgress = false;
  const queuedAfterAbort: Array<{ message: UserMessage; attachments: PhoneAttachment[] }> = [];
  let assistantTextEmitted = false;
  let thinking = false;
  let pendingText = '';
  let pendingKind: 'output' | 'thinking' | null = null;
  let pendingFlushTimer: NodeJS.Timeout | null = null;
  let outputStreamId = randomUUID();
  let thinkingStreamId = randomUUID();
  let lastPlanJson = '';
  const liveDelegateBindings = new Set<DelegateTaskBinding>();
  const compactTodoCallIds = new Set<string>();
  const activeInteractiveBashCalls = new Set<string>();
  let pendingPtyPrompt: PendingPtyPrompt | null = null;
  let ptyPromptScanBuffer = '';
  let ptyPromptTimer: NodeJS.Timeout | null = null;
  const activeDelegateTasksByBridge = new Map<string, Map<string, DelegateTaskBinding[]>>();
  const childMirrorsBySource = new Map<BridgeFrameSource, ChildMirrorState>();
  let bridgeServer: BridgeServer | null = null;
  let bridgeReadyResolved = false;
  let resolveBridgeReady: (() => void) | null = null;
  let rejectBridgeReady: ((error: Error) => void) | null = null;
  const initialRunMode: RunMode = 'remote';
  let runMode: RunMode = initialRunMode;
  let advisorEnabled = opts.extraArgs?.includes('--advisor') ?? false;
  let stdinDataHandler: ((data: string | Buffer) => void) | null = null;
  let stdinRawModeEnabled = false;
  let stdinResumed = false;
  let resizeHandler: (() => void) | null = null;
  const bunOmpBinary = join(homedir(), '.bun', 'bin', 'omp');
  const localOmpBinary = join(homedir(), '.local', 'bin', 'omp');
  const ompBinary = process.env.OMP_HAPPY_REAL_BIN
    || (existsSync(bunOmpBinary) ? bunOmpBinary : existsSync(localOmpBinary) ? localOmpBinary : 'omp');
  const runOmpConfigCommand = createOmpConfigCommandRunner(ompBinary);
  let lastPersistedModel: string | undefined;
  let modelPersistenceQueue = Promise.resolve();


  const log = (message: string, data?: unknown) => {
    logger.debug(`[happy-omp] ${message}`, data);
    if (verbose) {
      console.log(`[happy-omp] ${message}`);
    }
  };
  const persistSelectedModel = (modelSpec: string): Promise<boolean> => {
    if (lastPersistedModel === modelSpec) {
      return Promise.resolve(true);
    }
    let succeeded = false;
    const operation = modelPersistenceQueue.then(async () => {
      if (lastPersistedModel === modelSpec) {
        succeeded = true;
        return;
      }
      try {
        await persistOmpDefaultModel(modelSpec, runOmpConfigCommand);
        lastPersistedModel = modelSpec;
        succeeded = true;
      } catch (error) {
        log('Failed to persist OMP default model', error);
      }
    });
    modelPersistenceQueue = operation;
    return operation.then(() => succeeded);
  };

  const clearPendingPtyPrompt = (): void => {
    if (ptyPromptTimer) {
      clearTimeout(ptyPromptTimer);
      ptyPromptTimer = null;
    }
    pendingPtyPrompt = null;
    ptyPromptScanBuffer = '';
  };

  const publishPtyPrompt = (prompt: string, callId?: string): void => {
    if (pendingPtyPrompt) {
      return;
    }
    const id = `omp-pty-${randomUUID()}`;
    pendingPtyPrompt = { id, callId };
    session.sendAgentMessage('omp', {
      type: 'permission-request',
      permissionId: id,
      toolName: 'AskUserQuestion',
      description: prompt,
      ...(callId ? { parentToolCallId: callId } : {}),
      options: {
        inputKind: 'password',
        questions: [{
          id: 'password',
          question: prompt,
          header: 'Authentication',
          options: [],
          multiSelect: false,
          secret: true,
        }],
      },
    });
  };

  const scanPtyOutputForPasswordPrompt = (data: string): void => {
    ptyPromptScanBuffer = `${ptyPromptScanBuffer}${data}`.slice(-PTY_PROMPT_MAX_CHARS);
    if (pendingPtyPrompt || activeInteractiveBashCalls.size === 0) {
      return;
    }
    const callId = activeInteractiveBashCalls.size === 1
      ? activeInteractiveBashCalls.values().next().value
      : undefined;
    const explicitSudoPrompt = detectExplicitSudoPasswordPrompt(ptyPromptScanBuffer);
    if (explicitSudoPrompt) {
      if (ptyPromptTimer) {
        clearTimeout(ptyPromptTimer);
        ptyPromptTimer = null;
      }
      publishPtyPrompt(explicitSudoPrompt, callId);
      return;
    }
    clearTimeout(ptyPromptTimer ?? undefined);
    ptyPromptTimer = setTimeout(() => {
      ptyPromptTimer = null;
      const prompt = detectTrailingPasswordPrompt(ptyPromptScanBuffer);
      if (prompt) {
        publishPtyPrompt(prompt, callId);
      }
    }, PTY_PROMPT_SETTLE_MS);
  };


  const settleBridgeReady = (error?: Error): void => {
    if (bridgeReadyResolved) {
      return;
    }
    bridgeReadyResolved = true;
    if (error) {
      rejectBridgeReady?.(error);
    } else {
      resolveBridgeReady?.();
    }
    resolveBridgeReady = null;
    rejectBridgeReady = null;
  };

  const waitForBridgeReady = (): Promise<void> => {
    if (bridgeReadyResolved) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      resolveBridgeReady = resolve;
      rejectBridgeReady = reject;
      setTimeout(() => {
        if (!bridgeReadyResolved) {
          settleBridgeReady(new Error('Timed out waiting for the bundled OMP Happy extension bridge'));
        }
      }, BRIDGE_READY_TIMEOUT_MS);
    });
  };

  const flushPendingText = (): void => {
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    const text = pendingText;
    const kind = pendingKind;
    pendingText = '';
    pendingKind = null;
    if (!text || !kind) {
      return;
    }
    if (kind === 'thinking') {
      session.sendAgentMessage('omp', { type: 'thinking', text, streamId: thinkingStreamId, append: true });
      return;
    }
    session.sendAgentMessage('omp', { type: 'message', message: text, streamId: outputStreamId, append: true });
  };

  const schedulePendingFlush = (): void => {
    if (pendingFlushTimer) {
      return;
    }
    pendingFlushTimer = setTimeout(() => {
      pendingFlushTimer = null;
      flushPendingText();
    }, MIRROR_FLUSH_DELAY_MS);
  };

  const appendPendingText = (kind: 'output' | 'thinking', text: string): void => {
    if (!text) {
      return;
    }
    if (pendingKind && pendingKind !== kind) {
      flushPendingText();
    }
    pendingKind = kind;
    pendingText += text;
    schedulePendingFlush();
  };

  const emitPlanTodos = (result: unknown): void => {
    const todos = extractTodoEntries(result);
    const json = JSON.stringify(todos);
    if (todos.length === 0 && !lastPlanJson) {
      return;
    }
    if (json === lastPlanJson) {
      return;
    }
    lastPlanJson = json;
    flushPendingText();
    const planCallId = `omp-plan-${randomUUID()}`;
    session.sendAgentMessage('omp', { type: 'tool-call', name: 'TodoWrite', callId: planCallId, input: { todos }, id: randomUUID() });
    session.sendAgentMessage('omp', { type: 'tool-result', callId: planCallId, output: { todos }, id: randomUUID() });
  };

  const setRunMode = (nextMode: RunMode): void => {
    runMode = nextMode;
    session.sendSessionEvent({ type: 'switch', mode: runMode });
    session.updateAgentState((currentState) => ({
      ...currentState,
      controlledByUser: runMode === 'local',
    }));
    session.keepAlive(thinking, runMode);
    bridgeServer?.send({ type: 'set_control_mode', mode: runMode });
  };

  const prepareDelegateTaskInput = (parentBridgeKey: string, callId: string, input: unknown): unknown => {
    const normalized = normalizeBridgeToolInput('delegate_task', input);
    let bridgeCalls = activeDelegateTasksByBridge.get(parentBridgeKey);
    if (!bridgeCalls) {
      bridgeCalls = new Map();
      activeDelegateTasksByBridge.set(parentBridgeKey, bridgeCalls);
    }
    if (!isRecord(normalized) || !Array.isArray(normalized.tasks)) {
      bridgeCalls.delete(callId);
      if (bridgeCalls.size === 0) activeDelegateTasksByBridge.delete(parentBridgeKey);
      return normalized;
    }
    const previous = bridgeCalls.get(callId) ?? [];
    const bindings = normalized.tasks.flatMap((task, taskIndex) => {
      if (!isRecord(task)) return [];
      const taskName = asString(task.id) ?? `task-${taskIndex + 1}`;
      const indexedPrevious = previous[taskIndex];
      const sameNamePrevious = previous.filter((candidate) => candidate.taskName === taskName);
      const binding = indexedPrevious?.taskName === taskName
        ? indexedPrevious
        : sameNamePrevious.length === 1 ? sameNamePrevious[0] : undefined;
      if (binding) {
        binding.taskIndex = taskIndex;
        binding.completed = false;
        return [binding];
      }
      return [{
        parentBridgeKey,
        callId,
        taskIndex,
        taskName,
        sessionSubagent: createId(),
        started: false,
        completed: false,
      }];
    });
    bridgeCalls.set(callId, bindings);
    for (const binding of bindings) liveDelegateBindings.add(binding);
    return {
      ...normalized,
      tasks: normalized.tasks.map((task, taskIndex) => {
        if (!isRecord(task)) return task;
        const binding = bindings.find((candidate) => candidate.taskIndex === taskIndex);
        return binding ? { ...task, sessionSubagent: binding.sessionSubagent } : task;
      }),
    };
  };

  const sendBindingEnvelope = (binding: DelegateTaskBinding, event: SessionEvent): void => {
    session.sendSessionProtocolMessage(createEnvelope('agent', event, {
      turn: binding.sessionSubagent,
      subagent: binding.sessionSubagent,
    }));
  };

  const sendChildEnvelope = (state: ChildMirrorState, event: SessionEvent): void => {
    if (!state.binding || state.discarded) return;
    sendBindingEnvelope(state.binding, event);
  };

  const flushChildMessage = (state: ChildMirrorState, message?: unknown): void => {
    const complete = extractChildMessageParts(message);
    const text = complete.text || state.pendingText;
    const childThinking = complete.thinking || state.pendingThinking;
    const messageId = isRecord(message) ? asString(message.id) : undefined;
    if (messageId && state.seenMessageIds.has(messageId)) {
      state.pendingText = '';
      state.pendingThinking = '';
      state.messageOpen = false;
      return;
    }
    const duplicate = !state.messageOpen && text === state.lastText && childThinking === state.lastThinking;
    if (!duplicate) {
      if (childThinking) {
        sendChildEnvelope(state, { t: 'text', text: childThinking, thinking: true });
      }
      if (text) {
        sendChildEnvelope(state, { t: 'text', text });
      }
      state.lastText = text;
      state.lastThinking = childThinking;
    }
    if (messageId) {
      if (state.seenMessageIds.size >= MAX_SEEN_CHILD_MESSAGES) {
        const oldest = state.seenMessageIds.values().next().value;
        if (typeof oldest === 'string') state.seenMessageIds.delete(oldest);
      }
      state.seenMessageIds.add(messageId);
    }
    state.pendingText = '';
    state.pendingThinking = '';
    state.messageOpen = false;
  };

  const stopChildMirror = (state: ChildMirrorState, completed: boolean): void => {
    if (state.stopped) return;
    if (state.pendingText || state.pendingThinking) {
      flushChildMessage(state);
    }
    sendChildEnvelope(state, { t: 'stop' });
    state.stopped = true;
    if (state.binding?.source === state.source) {
      state.binding.source = undefined;
      if (completed) state.binding.completed = true;
      if (completed) liveDelegateBindings.delete(state.binding);
    }
  };

  const translateChildEvent = (state: ChildMirrorState, event: MirrorEvent): void => {
    if (state.stopped || state.discarded || !state.binding) return;
    const bridgeKey = state.binding.sessionSubagent;
    switch (event.type) {
      case 'message_start': {
        if (isAssistantMessage(event.message)) {
          state.pendingText = '';
          state.pendingThinking = '';
          state.messageOpen = true;
        }
        return;
      }
      case 'message_update': {
        if (!isAssistantMessage(event.message) || !isRecord(event.assistantMessageEvent)) return;
        state.messageOpen = true;
        const delta = asString(event.assistantMessageEvent.delta) ?? '';
        if (event.assistantMessageEvent.type === 'text_delta') {
          state.pendingText = appendBoundedChildText(state.pendingText, delta);
        } else if (event.assistantMessageEvent.type === 'thinking_delta') {
          state.pendingThinking = appendBoundedChildText(state.pendingThinking, delta);
        } else if (event.assistantMessageEvent.type === 'error') {
          const errorMessage = isRecord(event.assistantMessageEvent.error)
            ? asString(event.assistantMessageEvent.error.errorMessage)
            : undefined;
          if (errorMessage) state.pendingText = appendBoundedChildText(state.pendingText, errorMessage);
        }
        return;
      }
      case 'message_end': {
        if (isAssistantMessage(event.message)) flushChildMessage(state, event.message);
        return;
      }
      case 'tool_execution_update': {
        applyDelegateTaskProgress(bridgeKey, event);
        return;
      }
      case 'tool_execution_start': {
        const rawToolCallId = asString(event.toolCallId) ?? createId();
        if (state.toolCallIds.has(rawToolCallId)) return;
        const childToolCallId = `omp-child:${bridgeKey}:${rawToolCallId}`;
        state.toolCallIds.set(rawToolCallId, childToolCallId);
        const rawToolName = asString(event.toolName) ?? 'tool';
        const toolName = normalizeBridgeToolName(rawToolName);
        const normalizedInput = toolName === 'delegate_task'
          ? prepareDelegateTaskInput(bridgeKey, rawToolCallId, event.args)
          : normalizeBridgeToolInput(toolName, event.args);
        const args = isRecord(normalizedInput) ? normalizedInput : { input: normalizedInput };
        const intent = asString(args.i);
        sendChildEnvelope(state, {
          t: 'tool-call-start',
          call: childToolCallId,
          name: toolName,
          title: toolName,
          description: intent?.slice(0, 512) ?? toolName,
          args,
        });
        return;
      }
      case 'tool_execution_end': {
        const rawToolCallId = asString(event.toolCallId);
        if (!rawToolCallId || state.completedToolCalls.has(rawToolCallId)) return;
        const childToolCallId = state.toolCallIds.get(rawToolCallId)
          ?? `omp-child:${bridgeKey}:${rawToolCallId}`;
        sendChildEnvelope(state, { t: 'tool-call-end', call: childToolCallId });
        state.completedToolCalls.add(rawToolCallId);
        return;
      }
      case 'agent_end': {
        if (state.pendingText || state.pendingThinking) flushChildMessage(state);
        return;
      }
      case 'session_shutdown': {
        releaseBinding(state.binding);
        return;
      }
      default:
        return;
    }
  };
  const applyDelegateTaskProgress = (parentBridgeKey: string, event: MirrorEvent): void => {
    const callId = asString(event.toolCallId);
    const bindings = callId ? activeDelegateTasksByBridge.get(parentBridgeKey)?.get(callId) : undefined;
    const details = isRecord(event.partialResult) && isRecord(event.partialResult.details)
      ? event.partialResult.details
      : undefined;
    const progress = details && Array.isArray(details.progress) ? details.progress : undefined;
    if (!callId || !bindings || !progress) return;
    const changedRegistryNames = new Set<string>();
    for (const item of progress) {
      if (!isRecord(item) || !Number.isInteger(item.index) || typeof item.id !== 'string' || item.id.length === 0) {
        continue;
      }
      const binding = bindings.find((candidate) => candidate.taskIndex === item.index);
      if (!binding) continue;
      if (binding.registryName && binding.registryName !== item.id) {
        log(`Ignoring changed OMP child registry id for delegate task ${parentBridgeKey}:${callId}:${item.index}`);
        continue;
      }
      binding.registryName = item.id;
      changedRegistryNames.add(item.id);
    }
    for (const changedRegistryName of changedRegistryNames) tryBindChildRegistryName(changedRegistryName);
  };

  const removeBindingFromParentCall = (binding: DelegateTaskBinding): void => {
    const bridgeCalls = activeDelegateTasksByBridge.get(binding.parentBridgeKey);
    const bindings = bridgeCalls?.get(binding.callId);
    if (!bridgeCalls || !bindings) return;
    const remaining = bindings.filter((candidate) => candidate !== binding);
    if (remaining.length > 0) {
      bridgeCalls.set(binding.callId, remaining);
    } else {
      bridgeCalls.delete(binding.callId);
      if (bridgeCalls.size === 0) activeDelegateTasksByBridge.delete(binding.parentBridgeKey);
    }
  };

  const releaseBinding = (
    binding: DelegateTaskBinding,
    terminalStatus?: 'completed' | 'failed' | 'cancelled',
  ): void => {
    if (binding.completed) return;
    const state = binding.source ? childMirrorsBySource.get(binding.source) : undefined;
    if (terminalStatus) {
      if (!binding.started) {
        sendBindingEnvelope(binding, { t: 'start', title: binding.taskName });
        binding.started = true;
      }
      if (state && (state.pendingText || state.pendingThinking)) flushChildMessage(state);
      sendBindingEnvelope(binding, { t: 'turn-end', status: terminalStatus });
    }

    const descendants = [...liveDelegateBindings]
      .filter((candidate) => candidate.parentBridgeKey === binding.sessionSubagent);
    activeDelegateTasksByBridge.delete(binding.sessionSubagent);
    for (const descendant of descendants) releaseBinding(descendant);

    if (state) {
      stopChildMirror(state, true);
    } else {
      if (binding.started) sendBindingEnvelope(binding, { t: 'stop' });
      binding.completed = true;
      binding.source = undefined;
      liveDelegateBindings.delete(binding);
    }
    removeBindingFromParentCall(binding);
  };

  const releaseBridgeBindings = (bridgeKey: string): void => {
    activeDelegateTasksByBridge.delete(bridgeKey);
    const bindings = [...liveDelegateBindings]
      .filter((binding) => binding.parentBridgeKey === bridgeKey);
    for (const binding of bindings) releaseBinding(binding);
  };

  const handleSubagentLifecycle = (
    parentBridgeKey: string,
    frame: BridgeSubagentLifecycleFrame,
  ): void => {
    const id = asString(frame.payload.id);
    const callId = asString(frame.payload.parentToolCallId);
    const taskIndex = frame.payload.index;
    const status = frame.payload.status;
    if (
      !id
      || !callId
      || !Number.isInteger(taskIndex)
      || (taskIndex as number) < 0
      || (status !== 'started' && status !== 'completed' && status !== 'failed' && status !== 'aborted')
    ) {
      return;
    }
    if (
      frame.payload.sessionFile !== undefined
      && getSessionRegistryName(frame.payload.sessionFile) !== id
    ) {
      log(`Ignoring OMP child lifecycle with mismatched session file for ${parentBridgeKey}:${callId}:${taskIndex}`);
      return;
    }
    const bindings = activeDelegateTasksByBridge.get(parentBridgeKey)?.get(callId);
    const binding = bindings?.find((candidate) => candidate.taskIndex === taskIndex);
    if (!binding || binding.completed) return;
    if (binding.registryName && binding.registryName !== id) {
      log(`Ignoring changed OMP child lifecycle id for delegate task ${parentBridgeKey}:${callId}:${taskIndex}`);
      return;
    }
    binding.registryName = id;
    tryBindChildRegistryName(id);
    if (status === 'started') {
      if (!binding.started) {
        sendBindingEnvelope(binding, { t: 'start', title: binding.taskName });
        binding.started = true;
      }
      return;
    }
    releaseBinding(
      binding,
      status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled',
    );
  };

  const translateBoundChildFrame = (
    state: ChildMirrorState,
    frame: BridgeAgentEventFrame | BridgeSubagentLifecycleFrame,
  ): void => {
    if (!state.binding) return;
    if (frame.type === 'subagent_lifecycle') {
      handleSubagentLifecycle(state.binding.sessionSubagent, frame);
    } else {
      translateChildEvent(state, frame.event);
    }
  };

  const tryBindChildRegistryName = (registryName: string): void => {
    const matchingBindings = [...liveDelegateBindings]
      .filter((binding) => !binding.completed && binding.registryName === registryName);
    const pendingChildren = [...childMirrorsBySource.values()]
      .filter((state) => !state.binding && !state.discarded && !state.stopped && state.source.childRegistryName === registryName);
    if (matchingBindings.length !== 1 || pendingChildren.length !== 1) {
      if (matchingBindings.length > 1 || pendingChildren.length > 1) {
        log(`Ignoring ambiguous OMP child registry name ${registryName}`);
      }
      return;
    }
    const binding = matchingBindings[0];
    const state = pendingChildren[0];
    const eligibleThroughParent = state.parentRegistryName
      ? [...childMirrorsBySource.values()].some((parentState) => (
        parentState !== state
        && parentState.source.childRegistryName === state.parentRegistryName
        && parentState.binding?.sessionSubagent === binding.parentBridgeKey
      ))
      : false;
    if (!state.eligibleBindings.has(binding) && !eligibleThroughParent) {
      log(`Ignoring OMP child registry name ${registryName} without an eligible parent binding`);
      return;
    }
    if (binding.source) {
      state.discarded = true;
      state.bufferedFrames = [];
      log(`Ignoring duplicate OMP child socket for ${registryName}`);
      return;
    }
    binding.source = state.source;
    state.binding = binding;
    if (!binding.started) {
      sendChildEnvelope(state, { t: 'start', title: binding.taskName });
      binding.started = true;
    }
    const buffered = state.bufferedFrames.splice(0);
    for (const frame of buffered) translateBoundChildFrame(state, frame);
  };


  const handleAssistantMessageUpdate = (event: MirrorEvent): void => {
    if (!isAssistantMessage(event.message) || !isRecord(event.assistantMessageEvent)) {
      return;
    }
    const eventType = event.assistantMessageEvent.type;
    if (eventType === 'text_delta') {
      const delta = asString(event.assistantMessageEvent.delta) ?? '';
      if (delta.length > 0) {
        assistantTextEmitted = true;
        appendPendingText('output', delta);
      }
      return;
    }
    if (eventType === 'thinking_delta') {
      const delta = asString(event.assistantMessageEvent.delta) ?? '';
      if (delta.length > 0) {
        appendPendingText('thinking', delta);
      }
      return;
    }
    if (eventType === 'error') {
      const errorMessage = isRecord(event.assistantMessageEvent.error)
        ? asString(event.assistantMessageEvent.error.errorMessage)
        : undefined;
      if (errorMessage) {
        assistantTextEmitted = true;
        appendPendingText('output', errorMessage);
      }
    }
  };

  const completeTurn = (): void => {
    if (!turnStarted) return;
    flushPendingText();
    turnStarted = false;
    thinking = false;
    session.keepAlive(false, runMode);
    session.sendAgentMessage('omp', { type: 'task_complete', id: randomUUID() });
    session.sendSessionEvent({ type: 'ready' });
  };

  const releaseQueuedAfterAbort = (): void => {
    if (!abortInProgress) return;
    abortInProgress = false;
    const queued = queuedAfterAbort.splice(0);
    for (const item of queued) {
      sendPhonePrompt(item.message, item.attachments, false);
    }
  };

  const handleBridgeEvent = (event: MirrorEvent): void => {
    switch (event.type) {
      case 'agent_start': {
        turnStarted = true;
        assistantTextEmitted = false;
        pendingText = '';
        pendingKind = null;
        lastPlanJson = '';
        outputStreamId = randomUUID();
        thinkingStreamId = randomUUID();
        thinking = true;
        session.keepAlive(thinking, runMode);
        session.sendAgentMessage('omp', { type: 'task_started', id: randomUUID() });
        return;
      }
      case 'tool_execution_update': {
        applyDelegateTaskProgress(ROOT_BRIDGE_KEY, event);
        return;
      }
      case 'message_update': {
        handleAssistantMessageUpdate(event);
        return;
      }
      case 'message_end': {
        if (isUserMessage(event.message)) {
          return;
        }
        if (isAssistantMessage(event.message) && !assistantTextEmitted) {
          const text = extractMessageText(event.message);
          if (text.length > 0) {
            assistantTextEmitted = true;
            appendPendingText('output', text);
            flushPendingText();
          }
        }
        const advisorNotes = extractAdvisorNotes(event.message);
        if (advisorNotes.length > 0) {
          flushPendingText();
          session.sendAgentMessage('omp', { type: 'advisor', notes: advisorNotes });
        }
        return;
      }
      case 'tool_execution_start': {
        flushPendingText();
        outputStreamId = randomUUID();
        thinkingStreamId = randomUUID();
        const rawToolName = asString(event.toolName) ?? 'tool';
        const toolName = normalizeBridgeToolName(rawToolName);
        const toolCallId = asString(event.toolCallId) ?? randomUUID();
        if (rawToolName === 'happy_ask') {
          return;
        }
        if (rawToolName === 'todo') {
          compactTodoCallIds.add(toolCallId);
          return;
        }
        if (rawToolName === 'bash') {
          activeInteractiveBashCalls.add(toolCallId);
          // PTY output and extension lifecycle events arrive on independent
          // channels. Rescan output that may have reached us just before the
          // tool start frame instead of discarding a fast password prompt.
          scanPtyOutputForPasswordPrompt('');
        }
        const input = toolName === 'delegate_task'
          ? prepareDelegateTaskInput(ROOT_BRIDGE_KEY, toolCallId, event.args)
          : normalizeBridgeToolInput(toolName, event.args);
        session.sendAgentMessage('omp', {
          type: 'tool-call',
          name: toolName,
          callId: toolCallId,
          input,
          id: randomUUID(),
        });
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = asString(event.toolCallId) ?? randomUUID();
        if (asString(event.toolName) === 'happy_ask') {
          return;
        }
        const wasInteractiveBash = activeInteractiveBashCalls.delete(toolCallId);
        if (wasInteractiveBash && pendingPtyPrompt?.callId === toolCallId) {
          clearPendingPtyPrompt();
        } else if (wasInteractiveBash && activeInteractiveBashCalls.size === 0) {
          if (ptyPromptTimer) {
            clearTimeout(ptyPromptTimer);
            ptyPromptTimer = null;
          }
          ptyPromptScanBuffer = '';
        }
        if (compactTodoCallIds.delete(toolCallId)) {
          emitPlanTodos(event.result);
          return;
        }
        session.sendAgentMessage('omp', {
          type: 'tool-result',
          callId: toolCallId,
          output: event.result,
          id: randomUUID(),
          isError: extractToolError(event.result, event.isError),
        });
        return;
      }
      case 'session_shutdown': {
        releaseBridgeBindings(ROOT_BRIDGE_KEY);
        return;
      }
      case 'agent_end': {
        completeTurn();
        releaseQueuedAfterAbort();
        return;
      }
      case 'notice': {
        const level = asString(event.level) ?? 'info';
        const message = asString(isRecord(event.message) ? undefined : event.message) ?? '';
        if (message.trim().length > 0) {
          session.sendAgentMessage('omp', { type: 'message', message: `[${level}] ${message}` });
        }
        return;
      }
      default:
        return;
    }
  };

  const updateSessionTitle = (value: string): string | undefined => {
    const title = value.trim();
    if (!title) return undefined;
    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      summary: {
        text: title,
        updatedAt: Date.now(),
      },
    }));
    return title;
  };

  const handleChildBridgeFrame = (frame: BridgeFrame, source: BridgeFrameSource): void => {
    if (frame.type === 'ready') {
      const registryName = source.childRegistryName;
      if (!registryName) return;
      if (!childMirrorsBySource.has(source)) {
        childMirrorsBySource.set(source, {
          source,
          eligibleBindings: new Set(liveDelegateBindings),
          ...(registryName.includes('.')
            ? { parentRegistryName: registryName.slice(0, registryName.lastIndexOf('.')) }
            : {}),
          bufferedFrames: [],
          discarded: false,
          pendingText: '',
          pendingThinking: '',
          messageOpen: false,
          lastText: '',
          lastThinking: '',
          seenMessageIds: new Set(),
          toolCallIds: new Map(),
          completedToolCalls: new Set(),
          stopped: false,
        });
      }
      tryBindChildRegistryName(registryName);
      return;
    }
    if (frame.type !== 'agent_event' && frame.type !== 'subagent_lifecycle') return;
    const state = childMirrorsBySource.get(source);
    if (!state || state.discarded || state.stopped) return;
    if (state.binding) {
      translateBoundChildFrame(state, frame);
      return;
    }
    if (frame.type === 'agent_event') {
      switch (frame.event.type) {
        case 'message_start':
        case 'message_update':
        case 'message_end':
        case 'tool_execution_update':
        case 'tool_execution_start':
        case 'tool_execution_end':
        case 'agent_end':
        case 'session_shutdown':
          break;
        default:
          return;
      }
    }
    if (state.bufferedFrames.length >= MAX_BUFFERED_CHILD_EVENTS) {
      state.discarded = true;
      state.bufferedFrames = [];
      log(`Dropping oversized unbound OMP child stream ${source.childRegistryName}`);
      return;
    }
    state.bufferedFrames.push(frame);
  };

  const handleBridgeDisconnect = (source: BridgeFrameSource): void => {
    const state = childMirrorsBySource.get(source);
    if (!state) return;
    if (state.binding?.source === source) {
      state.binding.source = undefined;
    }
    if (state.bufferedFrames.length > 0) {
      log(`Retaining OMP child binding across bridge reconnect for ${source.childRegistryName ?? source.sessionId ?? source.connectionId}`);
    }
    childMirrorsBySource.delete(source);
  };

  const handleBridgeFrame = (frame: BridgeFrame, source: BridgeFrameSource): void => {
    if (!source.primary) {
      handleChildBridgeFrame(frame, source);
      return;
    }
    if (frame.type === 'subagent_lifecycle') {
      handleSubagentLifecycle(ROOT_BRIDGE_KEY, frame);
      return;
    }
    if (frame.type === 'ready') {
      log(`OMP Happy extension ready for session ${frame.sessionId}`);
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        flavor: 'omp',
        ompSessionId: frame.sessionId,
        advisorEnabled,
        ...(Array.isArray(frame.models) ? { models: frame.models } : {}),
        ...(typeof frame.currentModel === 'string' ? { currentModelCode: frame.currentModel } : {}),
        ...(Array.isArray(frame.thoughtLevels) ? { thoughtLevels: frame.thoughtLevels } : {}),
        ...(typeof frame.currentThoughtLevel === 'string' ? { currentThoughtLevelCode: frame.currentThoughtLevel } : {}),
      }));
      if (typeof frame.title === 'string') {
        updateSessionTitle(frame.title);
      }
      settleBridgeReady();
      bridgeServer?.send({ type: 'set_control_mode', mode: runMode });
      return;
    }
    if (frame.type === 'ask_request') {
      session.sendAgentMessage('omp', {
        type: 'permission-request',
        permissionId: frame.id,
        toolName: 'AskUserQuestion',
        description: frame.questions.map((question) => question.question).join('\n'),
        options: {
          questions: frame.questions.map((question) => ({
            ...question,
            header: question.header ?? question.id,
            multiSelect: question.multi === true,
          })),
        },
      });
      return;
    }
    if (frame.type === 'change_title') {
      const title = updateSessionTitle(frame.title);
      if (title) log(`Changed Happy session title to "${title}"`);
      return;
    }
    if (frame.type === 'tui_command_ready') {
      writeToChild('\r');
      return;
    }
    if (frame.type === 'input') {
      if (frame.source === 'extension') return;
      const text = frame.text.trim();
      if (!text) return;
      const advisorMatch = /^\/advisor(?:\s+(on|off|toggle))?\s*$/i.exec(text);
      if (advisorMatch) {
        const action = advisorMatch[1]?.toLowerCase() ?? 'toggle';
        advisorEnabled = action === 'toggle' ? !advisorEnabled : action === 'on';
        session.updateMetadata((currentMetadata) => ({ ...currentMetadata, advisorEnabled }));
      }
      session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
      return;
    }
    if (frame.type === 'aborted') {
      if (abortInProgress) {
        completeTurn();
        releaseQueuedAfterAbort();
      }
      log('OMP abort request completed');
      return;
    }
    if (frame.type === 'bridge_error') {
      log(`OMP Happy extension error: ${frame.message}`);
      return;
    }
    handleBridgeEvent(frame.event);
  };

  const swallowSigint = (): void => {
    log('Received SIGINT in wrapper; waiting for omp child to handle it');
  };

  const startChild = (socketPath: string, extensionPath: string, configOverlayPath: string): void => {
    const childArgs = buildOmpArgs(opts, extensionPath, configOverlayPath);
    log(`Spawning native omp ${childArgs.join(' ')}`);
    child = spawnPty(ompBinary, childArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [BRIDGE_SOCKET_ENV]: socketPath,
        [BRIDGE_CONTROL_MODE_ENV]: runMode,
      },
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
    child.onData((data) => {
      process.stdout.write(data);
      scanPtyOutputForPasswordPrompt(data);
    });
    child.onExit(({ exitCode, signal }) => {
      log(`Native omp child exited (code=${exitCode} signal=${signal ?? 'null'})`);
      const err = new Error(`native omp exited with code ${exitCode} signal ${signal ?? 'null'}`);
      if (!bridgeReadyResolved) {
        setTimeout(() => {
          if (!bridgeReadyResolved) {
            settleBridgeReady(err);
          }
        }, BRIDGE_EXIT_GRACE_MS);
      } else {
        settleBridgeReady(err);
      }
      if (!shouldExit && turnStarted) {
        flushPendingText();
        session.sendAgentMessage('omp', { type: 'turn_aborted', id: randomUUID() });
      }
      shouldExit = true;
    });
  };

  const writeToChild = (data: string): void => {
    if (!child || data.length === 0) {
      return;
    }
    child.write(data);
  };


  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, runMode);
  }, KEEPALIVE_INTERVAL_MS);

  process.on('SIGINT', swallowSigint);
  session.onFileEvent((fileEvent) => {
    const event = fileEvent.content.data.ev;
    session.trackAttachmentDownload((async () => {
      try {
        const data = await session.downloadAndDecryptAttachment(event.ref);
        if (!data) return null;
        return {
          data,
          mimeType: event.mimeType ?? 'image/jpeg',
          name: event.name,
        };
      } catch (error) {
        logger.debug('[happy-omp] Failed to download phone attachment', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return null;
      }
    })());
  });
  const sendPhonePrompt = (message: UserMessage, attachments: PhoneAttachment[], steering: boolean): void => {
    const text = message.content.text?.trim() ?? '';
    // Both terminal and phone input share one control path. The app-backed
    // Ask tool remains active, so creating or typing locally cannot flip mode.
    if (!steering && typeof message.meta?.model === 'string') {
      bridgeServer?.send({ type: 'set_model', spec: message.meta.model });
      void persistSelectedModel(message.meta.model);
    }
    if (!steering && typeof message.meta?.effort === 'string') {
      bridgeServer?.send({ type: 'set_thinking_level', level: message.meta.effort });
    }
    bridgeServer?.send({
      type: 'prompt',
      text,
      ...(steering ? { deliverAs: 'steer' as const } : {}),
      images: attachments.map((attachment) => ({
        data: Buffer.from(attachment.data).toString('base64'),
        mimeType: attachment.mimeType || 'image/jpeg',
      })),
    });
    log(steering ? 'Sent remote steering message through the OMP extension bridge' : 'Sent remote prompt through the OMP extension bridge');
  };

  session.onUserMessage(async (message: UserMessage) => {
    const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
    if (!message.content.text && attachmentsForThisMessage.length === 0) {
      return;
    }
    const text = message.content.text?.trim() ?? '';
    log(`Received phone prompt (${text.length} chars, ${attachmentsForThisMessage.length} images)`);
    if (abortInProgress) {
      queuedAfterAbort.push({ message, attachments: attachmentsForThisMessage });
      log('Queued phone prompt until OMP abort completes');
      return;
    }
    sendPhonePrompt(message, attachmentsForThisMessage, turnStarted);
  });

  // Daemon sessions ignore inherited startup bytes unless the wrapper is
  // attached to a real TTY, where local keystrokes are intentional input.
  if (opts.startedBy !== 'daemon' || Boolean(process.stdin.isTTY)) {
    process.stdin.resume();
    stdinResumed = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      stdinRawModeEnabled = true;
    }
    process.stdin.setEncoding('utf8');
    stdinDataHandler = (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (text.length === 0) {
        return;
      }
      // Local keystrokes are forwarded without changing the shared control mode.
      writeToChild(text);
    };
    process.stdin.on('data', stdinDataHandler);
  }

  resizeHandler = () => {
    child?.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  process.on('SIGWINCH', resizeHandler);

  setRunMode(initialRunMode);
  session.updateMetadata((currentMetadata) => ({
    ...currentMetadata,
    flavor: 'omp',
  }));

  const requestAbort = (): void => {
    abortInProgress = true;
    bridgeServer?.send({ type: 'abort' });
  };

  session.rpcHandlerManager.registerHandler('abort', async () => {
    requestAbort();
  });
  session.rpcHandlerManager.registerHandler<{
    title: string;
  }, {
    success: boolean;
    message?: string;
  }>('change-title', async (request) => {
    const title = updateSessionTitle(request.title);
    if (!title) {
      return { success: false, message: 'Session title must not be empty' };
    }
    bridgeServer?.send({ type: 'set_title', title });
    return { success: true };
  });
  session.rpcHandlerManager.registerHandler<{
    model: string;
  }, {
    success: boolean;
  }>('set-model', async ({ model }) => {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return { success: false };
    }
    const sent = bridgeServer?.send({ type: 'set_model', spec: normalizedModel }) ?? false;
    const persisted = await persistSelectedModel(normalizedModel);
    return { success: sent && persisted };
  });
  session.rpcHandlerManager.registerHandler<{
    enabled: boolean;
  }, {
    success: boolean;
  }>('set-advisor', async ({ enabled }) => {
    const success = bridgeServer?.send({ type: 'set_advisor', enabled }) ?? false;
    return { success };
  });
  session.rpcHandlerManager.registerHandler<Record<string, never>, {
    success: boolean;
  }>('compact-snapcompact', async () => {
    const success = bridgeServer?.send({ type: 'compact_snapcompact' }) ?? false;
    return { success };
  });
  session.rpcHandlerManager.registerHandler<{
    action: 'set' | 'show' | 'pause' | 'resume' | 'drop';
    objective?: string;
  }, {
    success: boolean;
  }>('goal-command', async ({ action, objective }) => {
    if (!['set', 'show', 'pause', 'resume', 'drop'].includes(action)) {
      return { success: false };
    }
    if (action === 'set' && (typeof objective !== 'string' || !objective.trim())) {
      return { success: false };
    }
    const success = bridgeServer?.send({
      type: 'goal_command',
      action,
      ...(action === 'set' ? { objective } : {}),
    }) ?? false;
    return { success };
  });
  session.rpcHandlerManager.registerHandler<{
    id: string;
    approved: boolean;
    updatedInput?: { answers?: Record<string, string | string[]>; value?: string };
  }, void>('permission', async (response) => {
    if (pendingPtyPrompt?.id === response.id) {
      const answer = response.updatedInput?.answers?.password;
      const value = response.updatedInput?.value ?? (typeof answer === 'string' ? answer : undefined);
      if (response.approved && typeof value === 'string') {
        writeToChild(`${value}\r`);
      } else {
        writeToChild('\u0003');
      }
      session.sendAgentMessage('omp', {
        type: 'tool-result',
        callId: response.id,
        output: response.approved ? 'Input sent to the PTY.' : 'PTY input cancelled.',
        id: randomUUID(),
        isError: !response.approved,
      });
      clearPendingPtyPrompt();
      return;
    }
    // Ask is a tool-level interaction, not a permission gate. Always resolve
    // the pending bridge request so OMP can finish the tool call and continue.
    bridgeServer?.send({
      type: 'ask_response',
      id: response.id,
      answers: response.approved ? (response.updatedInput?.answers ?? {}) : {},
    });
  });

  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    archiveOnExit = true;
    shouldExit = true;
    try {
      const ptyChild = child as IPty | null;
      if (ptyChild) {
        ptyChild.kill('SIGTERM');
      }
    } catch (error) {
      logger.debug('[happy-omp] Failed to terminate child process:', error);
    }
  });

  const bridgeDir = await mkdtemp(join(tmpdir(), 'happy-omp-'));
  const socketPath = join(bridgeDir, 'bridge.sock');
  const extensionPath = join(projectPath(), 'scripts', BRIDGE_EXTENSION_FILE);
  const configOverlayPath = join(projectPath(), 'scripts', CONFIG_OVERLAY_FILE);

  try {
    bridgeServer = await startBridgeServer(socketPath, handleBridgeFrame, handleBridgeDisconnect, log);
    startChild(socketPath, extensionPath, configOverlayPath);
    await waitForBridgeReady();

    while (!shouldExit) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    clearInterval(keepAliveInterval);
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    clearPendingPtyPrompt();
    flushPendingText();
    process.off('SIGINT', swallowSigint);
    if (resizeHandler) {
      process.off('SIGWINCH', resizeHandler);
      resizeHandler = null;
    }
    if (stdinDataHandler) {
      process.stdin.off('data', stdinDataHandler);
      stdinDataHandler = null;
    }
    if (stdinRawModeEnabled && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      stdinRawModeEnabled = false;
    }
    if (stdinResumed) {
      process.stdin.pause();
      stdinResumed = false;
    }
    reconnectionHandle?.cancel();

    try {
      const ptyChild = child as IPty | null;
      if (ptyChild) {
        ptyChild.kill('SIGTERM');
      }
    } catch (error) {
      logger.debug('[happy-omp] Failed to terminate child process:', error);
    }

    try {
      await bridgeServer?.close();
      bridgeServer = null;
    } catch (error) {
      logger.debug('[happy-omp] Extension bridge shutdown failed:', error);
    }

    try {
      await rm(bridgeDir, { recursive: true, force: true });
    } catch (error) {
      logger.debug('[happy-omp] Failed to remove bridge dir:', error);
    }

    try {
      if (archiveOnExit) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
      }
      session.sendSessionDeath();
      log('Flushing and closing Happy session');
      const withShutdownTimeout = async (label: string, promise: Promise<unknown>): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            promise.then(() => undefined),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timed out after ${SESSION_CLOSE_TIMEOUT_MS}ms`)), SESSION_CLOSE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      await withShutdownTimeout('session.flush', session.flush());
      await withShutdownTimeout('session.close', session.close());
    } catch (error) {
      logger.debug('[happy-omp] Session close failed:', error);
    }
  }
}
