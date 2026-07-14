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

const KEEPALIVE_INTERVAL_MS = 2_000;
const MIRROR_FLUSH_DELAY_MS = 150;
const BRIDGE_READY_TIMEOUT_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const BRIDGE_EXIT_GRACE_MS = 300;
const BRIDGE_SOCKET_ENV = 'OMP_HAPPY_BRIDGE_SOCKET';
const BRIDGE_EXTENSION_FILE = 'omp-happy-bridge.mjs';

type RunMode = 'local' | 'remote';

type BridgeFrame = BridgeReadyFrame | BridgeAgentEventFrame | BridgeInputFrame | BridgeErrorFrame;

type BridgeReadyFrame = {
  type: 'ready';
  protocolVersion: number;
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
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
    default:
      return toolName;
  }
}

function normalizeBridgeToolInput(toolName: string, input: unknown): unknown {
  if (
    toolName === 'Glob'
    && isRecord(input)
    && typeof input.path === 'string'
    && typeof input.pattern !== 'string'
  ) {
    return { ...input, pattern: input.path };
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
  const phases = isRecord(result) ? result.phases : undefined;
  if (!Array.isArray(phases)) {
    return [];
  }
  return phases.flatMap((phase) => {
    if (!isRecord(phase) || !Array.isArray(phase.items)) {
      return [];
    }
    return phase.items.flatMap((item) => {
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
  let activeSocket: Socket | null = null;
  let pending = '';
  const outgoing: string[] = [];

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onFrame(JSON.parse(trimmed) as BridgeFrame);
    } catch (error) {
      log(`Failed to parse OMP bridge frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const server: Server = createServer((socket) => {
    activeSocket?.destroy();
    activeSocket = socket;
    pending = '';
    socket.setEncoding('utf8');
    for (const line of outgoing.splice(0)) socket.write(line);
    socket.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });
    socket.on('close', () => {
      if (activeSocket === socket) activeSocket = null;
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
      if (activeSocket?.writable) activeSocket.write(line);
      else outgoing.push(line);
      return true;
    },
    async close(): Promise<void> {
      activeSocket?.destroy();
      activeSocket = null;
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
  let assistantTextEmitted = false;
  let thinking = false;
  let pendingText = '';
  let pendingKind: 'output' | 'thinking' | null = null;
  let pendingFlushTimer: NodeJS.Timeout | null = null;
  let outputStreamId = randomUUID();
  let thinkingStreamId = randomUUID();
  let lastPlanJson = '';
  let bridgeServer: BridgeServer | null = null;
  let bridgeReadyResolved = false;
  let resolveBridgeReady: (() => void) | null = null;
  let rejectBridgeReady: ((error: Error) => void) | null = null;
  const initialRunMode: RunMode = opts.startedBy === 'daemon' ? 'remote' : 'local';
  let runMode: RunMode = initialRunMode;
  let stdinDataHandler: ((data: string | Buffer) => void) | null = null;
  let stdinRawModeEnabled = false;
  let stdinResumed = false;
  let resizeHandler: (() => void) | null = null;

  const log = (message: string, data?: unknown) => {
    logger.debug(`[happy-omp] ${message}`, data);
    if (verbose) {
      console.log(`[happy-omp] ${message}`);
    }
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
      if (kind === 'thinking') thinkingStreamId = randomUUID();
      else outputStreamId = randomUUID();
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
        return;
      }
      case 'tool_execution_start': {
        flushPendingText();
        outputStreamId = randomUUID();
        thinkingStreamId = randomUUID();
        const toolName = normalizeBridgeToolName(asString(event.toolName) ?? 'tool');
        const toolCallId = asString(event.toolCallId) ?? randomUUID();
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
        session.sendAgentMessage('omp', {
          type: 'tool-result',
          callId: toolCallId,
          output: event.result,
          id: randomUUID(),
          isError: extractToolError(event.result, event.isError),
        });
        emitPlanTodos(event.result);
        return;
      }
      case 'agent_end': {
        flushPendingText();
        turnStarted = false;
        thinking = false;
        session.keepAlive(false, runMode);
        session.sendAgentMessage('omp', { type: 'task_complete', id: randomUUID() });
        session.sendSessionEvent({ type: 'ready' });
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

  const handleBridgeFrame = (frame: BridgeFrame): void => {
    if (frame.type === 'ready') {
      log(`OMP Happy extension ready for session ${frame.sessionId}`);
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        flavor: 'omp',
        ompSessionId: frame.sessionId,
      }));
      settleBridgeReady();
      return;
    }
    if (frame.type === 'input') {
      if (frame.source === 'extension') return;
      const text = frame.text.trim();
      if (!text) return;
      if (runMode !== 'local') setRunMode('local');
      session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
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
    const installedOmpBinary = join(homedir(), '.local', 'bin', 'omp');
    const ompBinary = process.env.OMP_HAPPY_REAL_BIN || (existsSync(installedOmpBinary) ? installedOmpBinary : 'omp');
    log(`Spawning native omp ${childArgs.join(' ')}`);
    child = spawnPty(ompBinary, childArgs, {
      cwd: process.cwd(),
      env: { ...process.env, [BRIDGE_SOCKET_ENV]: socketPath },
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
  session.onUserMessage(async (message: UserMessage) => {
    const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
    if (!message.content.text && attachmentsForThisMessage.length === 0) {
      return;
    }
    const text = message.content.text?.trim() ?? '';
    log(`Received phone prompt (${text.length} chars, ${attachmentsForThisMessage.length} images)`);
    if (runMode !== 'remote') {
      log('Switching native OMP control to remote');
      flushPendingText();
      setRunMode('remote');
    }
    if (typeof message.meta?.model === 'string') {
      bridgeServer?.send({ type: 'set_model', spec: message.meta.model });
    }
    bridgeServer?.send({
      type: 'prompt',
      text,
      images: attachmentsForThisMessage.map((attachment) => ({
        data: Buffer.from(attachment.data).toString('base64'),
        mimeType: attachment.mimeType || 'image/jpeg',
      })),
    });
    log('Sent remote prompt through the OMP extension bridge');
  });

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
    if (runMode !== 'local') {
      flushPendingText();
      setRunMode('local');
    }
    writeToChild(text);
  };
  process.stdin.on('data', stdinDataHandler);

  resizeHandler = () => {
    child?.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  process.on('SIGWINCH', resizeHandler);

  setRunMode(initialRunMode);
  session.updateMetadata((currentMetadata) => ({
    ...currentMetadata,
    flavor: 'omp',
  }));

  session.rpcHandlerManager.registerHandler('abort', async () => {
    bridgeServer?.send({ type: 'abort' });
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
