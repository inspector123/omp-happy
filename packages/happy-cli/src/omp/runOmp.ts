import { randomUUID } from 'node:crypto';
import { open, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';

const KEEPALIVE_INTERVAL_MS = 2_000;
const MIRROR_POLL_INTERVAL_MS = 100;
const MIRROR_FLUSH_DELAY_MS = 150;
const MIRROR_READY_TIMEOUT_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const MIRROR_EXIT_GRACE_MS = 300;
const MIRROR_ENV = 'OMP_HAPPY_MIRROR_PATH';

type RunMode = 'local' | 'remote';

type MirrorFrame = MirrorReadyFrame | MirrorAgentEventFrame;

type MirrorReadyFrame = {
  type: 'ready';
};

type MirrorAgentEventFrame = {
  type: 'agent_event';
  event: MirrorEvent;
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

interface MirrorFollower {
  stop(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function buildOmpArgs(opts: RunOmpOptions): string[] {
  const args = (opts.extraArgs ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0 && value !== 'undefined',
  );
  if (!args.includes('--allow-home')) {
    args.unshift('--allow-home');
  }
  if (opts.yolo && !args.includes('--yolo') && !args.includes('--auto-approve') && !args.includes('--dangerously-skip-permissions')) {
    args.unshift('--yolo');
  }
  return args;
}

async function readChunk(filePath: string, offset: number, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function startMirrorFollower(
  mirrorPath: string,
  onFrame: (frame: MirrorFrame) => void,
  log: (message: string, data?: unknown) => void,
): MirrorFollower {
  let offset = 0;
  let pending = '';
  let stopped = false;
  let draining = false;
  let drainAgain = false;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const frame = JSON.parse(trimmed) as MirrorFrame;
      onFrame(frame);
    } catch (error) {
      log(`Failed to parse OMP mirror frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const drain = async (finalPass = false): Promise<void> => {
    if (draining) {
      drainAgain = true;
      return;
    }
    if (stopped && !finalPass) {
      return;
    }
    draining = true;
    try {
      while (true) {
        let size = 0;
        try {
          size = (await stat(mirrorPath)).size;
        } catch (error) {
          const code = isRecord(error) ? asString(error.code) : undefined;
          if (code === 'ENOENT') {
            break;
          }
          throw error;
        }
        if (size <= offset) {
          break;
        }
        const chunk = await readChunk(mirrorPath, offset, size - offset);
        offset = size;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          processLine(line);
        }
      }
    } finally {
      draining = false;
      if (drainAgain && !stopped) {
        drainAgain = false;
        void drain();
      }
    }
  };

  const interval = setInterval(() => {
    void drain();
  }, MIRROR_POLL_INTERVAL_MS);

  return {
    async stop(): Promise<void> {
      clearInterval(interval);
      await drain(true);
      stopped = true;
      if (pending.trim().length > 0) {
        processLine(pending);
      }
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
  let lastPlanJson = '';
  let mirrorFollower: MirrorFollower | null = null;
  let mirrorReadyResolved = false;
  let resolveMirrorReady: (() => void) | null = null;
  let rejectMirrorReady: ((error: Error) => void) | null = null;
  let runMode: RunMode = 'local';
  let pendingRemotePrompts: string[] = [];
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

  const settleMirrorReady = (error?: Error): void => {
    if (mirrorReadyResolved) {
      return;
    }
    mirrorReadyResolved = true;
    if (error) {
      rejectMirrorReady?.(error);
    } else {
      resolveMirrorReady?.();
    }
    resolveMirrorReady = null;
    rejectMirrorReady = null;
  };

  const waitForMirrorReady = (): Promise<void> => {
    if (mirrorReadyResolved) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      resolveMirrorReady = resolve;
      rejectMirrorReady = reject;
      setTimeout(() => {
        if (!mirrorReadyResolved) {
          settleMirrorReady(new Error('Timed out waiting for OMP Happy mirror readiness; is this the patched omp build?'));
        }
      }, MIRROR_READY_TIMEOUT_MS);
    });
  };

  const flushPendingText = (): void => {
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    const text = pendingText.trim();
    const kind = pendingKind;
    pendingText = '';
    pendingKind = null;
    if (!text || !kind) {
      return;
    }
    if (kind === 'thinking') {
      session.sendAgentMessage('omp', { type: 'thinking', text });
      return;
    }
    session.sendAgentMessage('omp', { type: 'message', message: text });
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
  };

  const isRemoteEcho = (text: string): boolean => {
    if (pendingRemotePrompts.length === 0) {
      return false;
    }
    if (pendingRemotePrompts[0] !== text) {
      return false;
    }
    pendingRemotePrompts.shift();
    return true;
  };

  const sendLocalUserPrompt = (message: unknown): void => {
    const text = extractMessageText(message).trim();
    if (!text || isRemoteEcho(text)) {
      return;
    }
    session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }));
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

  const handleMirrorEvent = (event: MirrorEvent): void => {
    switch (event.type) {
      case 'agent_start': {
        turnStarted = true;
        assistantTextEmitted = false;
        pendingText = '';
        pendingKind = null;
        lastPlanJson = '';
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
          flushPendingText();
          sendLocalUserPrompt(event.message);
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
        const toolName = asString(event.toolName) ?? 'tool';
        const toolCallId = asString(event.toolCallId) ?? randomUUID();
        session.sendAgentMessage('omp', {
          type: 'tool-call',
          name: toolName,
          callId: toolCallId,
          input: event.args,
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

  const handleMirrorFrame = (frame: MirrorFrame): void => {
    if (frame.type === 'ready') {
      log('OMP Happy mirror ready');
      settleMirrorReady();
      return;
    }
    handleMirrorEvent(frame.event);
  };

  const swallowSigint = (): void => {
    log('Received SIGINT in wrapper; waiting for omp child to handle it');
  };

  const startChild = async (mirrorPath: string): Promise<void> => {
    const childArgs = buildOmpArgs(opts);
    log(`Spawning literal omp ${childArgs.join(' ')}`);
    mirrorFollower = startMirrorFollower(mirrorPath, handleMirrorFrame, log);
    child = spawnPty('omp', childArgs, {
      cwd: process.cwd(),
      env: { ...process.env, [MIRROR_ENV]: mirrorPath },
      name: process.env.TERM || 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
    child.onData((data) => {
      process.stdout.write(data);
    });
    child.onExit(({ exitCode, signal }) => {
      log(`Literal omp child exited (code=${exitCode} signal=${signal ?? 'null'})`);
      const err = new Error(`literal omp exited with code ${exitCode} signal ${signal ?? 'null'}`);
      if (!mirrorReadyResolved) {
        setTimeout(() => {
          if (!mirrorReadyResolved) {
            settleMirrorReady(err);
          }
        }, MIRROR_EXIT_GRACE_MS);
      } else {
        settleMirrorReady(err);
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

  const sendRemotePromptToChild = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    pendingRemotePrompts.push(trimmed);
    writeToChild(text);
    if (!text.endsWith('\n') && !text.endsWith('\r')) {
      writeToChild('\r');
    }
  };

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, runMode);
  }, KEEPALIVE_INTERVAL_MS);

  process.on('SIGINT', swallowSigint);
  session.onFileEvent(() => {
    log('Ignoring phone file event; literal omp handoff currently supports text prompts only');
  });
  session.onUserMessage(async (message: UserMessage) => {
    const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
    if (!message.content.text && attachmentsForThisMessage.length === 0) {
      return;
    }
    if (attachmentsForThisMessage.length > 0) {
      log('Ignoring phone attachments while routing prompt text into literal omp');
    }
    const text = message.content.text?.trim();
    if (!text) {
      return;
    }
    if (runMode !== 'remote') {
      flushPendingText();
      setRunMode('remote');
    }
    sendRemotePromptToChild(text);
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

  setRunMode('local');
  session.updateMetadata((currentMetadata) => ({
    ...currentMetadata,
    flavor: 'omp',
  }));

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

  const mirrorDir = await mkdtemp(join(tmpdir(), 'happy-omp-'));
  const mirrorPath = join(mirrorDir, 'mirror.jsonl');

  try {
    await startChild(mirrorPath);
    await waitForMirrorReady();

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
      const follower = mirrorFollower as MirrorFollower | null;
      if (follower !== null) {
        await follower.stop();
      }
    } catch (error) {
      logger.debug('[happy-omp] Mirror follower shutdown failed:', error);
    }

    try {
      await rm(mirrorDir, { recursive: true, force: true });
    } catch (error) {
      logger.debug('[happy-omp] Failed to remove mirror dir:', error);
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
