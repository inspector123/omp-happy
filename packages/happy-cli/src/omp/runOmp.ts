import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn as spawnPty, type IPty } from 'node-pty';
import { createEnvelope } from '@slopus/happy-wire';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { UserMessage } from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
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
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const BRIDGE_EXIT_GRACE_MS = 300;
const BRIDGE_SOCKET_ENV = 'OMP_HAPPY_BRIDGE_SOCKET';
const BRIDGE_CONTROL_MODE_ENV = 'OMP_HAPPY_CONTROL_MODE';
const BRIDGE_EXTENSION_FILE = 'omp-happy-bridge.mjs';

type RunMode = 'local' | 'remote';

type BridgeFrame = BridgeReadyFrame | BridgeAgentEventFrame | BridgeInputFrame | BridgeErrorFrame | BridgeAbortedFrame | BridgeAskRequestFrame | BridgeChangeTitleFrame | BridgeTuiCommandReadyFrame;

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
  command: '/advisor on' | '/advisor off' | '/compact snapcompact';
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
  isError?: unknown;
  level?: unknown;
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

function buildOmpArgs(opts: RunOmpOptions, extensionPath: string): string[] {
  const extraArgs = (opts.extraArgs ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0 && value !== 'undefined',
  );
  const args = ['--allow-home', '--extension', extensionPath, ...extraArgs];
  if (opts.yolo && !args.includes('--auto-approve') && !args.includes('--approval-mode')) {
    args.unshift('--auto-approve');
  }
  return args;
}

async function startBridgeServer(
  socketPath: string,
  onFrame: (frame: BridgeFrame) => void,
  log: (message: string, data?: unknown) => void,
): Promise<BridgeServer> {
  type BridgeConnection = {
    pending: string;
    sessionId?: string;
  };

  const connections = new Map<Socket, BridgeConnection>();
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
        if (primarySessionId === null || primarySocket === socket || frame.sessionId === primarySessionId) {
          primarySessionId = frame.sessionId;
          primarySocket = socket;
          flushOutgoing(socket);
          onFrame(frame);
        } else {
          log(`Ignoring child OMP bridge session ${frame.sessionId}; primary is ${primarySessionId}`);
        }
        return;
      }

      if (primarySocket === socket) {
        onFrame(frame);
      }
    } catch (error) {
      log(`Failed to parse OMP bridge frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const server: Server = createServer((socket) => {
    const connection: BridgeConnection = { pending: '' };
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
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

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
  const compactTodoCallIds = new Set<string>();
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
  const installedOmpBinary = join(homedir(), '.local', 'bin', 'omp');
  const ompBinary = process.env.OMP_HAPPY_REAL_BIN || (existsSync(installedOmpBinary) ? installedOmpBinary : 'omp');
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
        session.sendAgentMessage('omp', {
          type: 'tool-call',
          name: toolName,
          callId: toolCallId,
          input: normalizeBridgeToolInput(toolName, event.args),
          id: randomUUID(),
        });
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = asString(event.toolCallId) ?? randomUUID();
        if (asString(event.toolName) === 'happy_ask') {
          return;
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

  const handleBridgeFrame = (frame: BridgeFrame): void => {
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

  const startChild = (socketPath: string, extensionPath: string): void => {
    const childArgs = buildOmpArgs(opts, extensionPath);
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
    id: string;
    approved: boolean;
    updatedInput?: { answers?: Record<string, string | string[]> };
  }, void>('permission', async (response) => {
    // Ask is a tool-level interaction, not a permission gate. Always resolve
    // the pending bridge request so OMP can finish the tool call and continue.
    bridgeServer?.send({
      type: 'ask_response',
      id: response.id,
      answers: response.approved ? (response.updatedInput?.answers ?? {}) : {},
    });
  });

  registerKillSessionHandler(session.rpcHandlerManager, async () => {
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

  try {
    bridgeServer = await startBridgeServer(socketPath, handleBridgeFrame, log);
    startChild(socketPath, extensionPath);
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
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
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
