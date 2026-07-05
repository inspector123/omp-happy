import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { connectionState } from '@/utils/serverConnectionErrors';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { logger } from '@/ui/logger';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 15_000;
const LOCAL_PROMPT = '\x1b[36momp› \x1b[0m';

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

type OmpRunMode = 'local' | 'remote';

type RpcResponseFrame = {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type RpcPromptResultFrame = {
  id?: string;
  type: 'prompt_result';
  agentInvoked: boolean;
};

type RpcAvailableCommandsUpdateFrame = {
  type: 'available_commands_update';
  commands: Array<{ name: string; description?: string }>;
};

type RpcSessionInfoUpdateFrame = {
  type: 'session_info_update';
  title?: string;
  sessionId?: string;
};

type RpcConfigUpdateFrame = {
  type: 'config_update';
  model?: unknown;
  thinkingLevel?: unknown;
};

type RpcReadyFrame = { type: 'ready' };

type RpcAgentEventFrame = {
  type: string;
  [key: string]: unknown;
};

type RpcPendingResponse = {
  command: string;
  resolve: (frame: RpcResponseFrame) => void;
  reject: (error: Error) => void;
};

type RpcImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};

type RpcPromptCommand = {
  id: string;
  type: 'prompt';
  message: string;
  images?: RpcImageContent[];
};

export interface RunOmpRpcOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  local?: boolean;
  verbose?: boolean;
  yolo?: boolean;
  extraArgs?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractAssistantText(message: unknown): string {
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

function isAssistantMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'assistant';
}

function isRpcResponseFrame(frame: unknown): frame is RpcResponseFrame {
  return isRecord(frame) && frame.type === 'response' && typeof frame.command === 'string' && typeof frame.success === 'boolean';
}

function isRpcPromptResultFrame(frame: unknown): frame is RpcPromptResultFrame {
  return isRecord(frame) && frame.type === 'prompt_result' && typeof frame.agentInvoked === 'boolean';
}

function isRpcAvailableCommandsUpdateFrame(frame: unknown): frame is RpcAvailableCommandsUpdateFrame {
  return isRecord(frame) && frame.type === 'available_commands_update' && Array.isArray(frame.commands);
}

function isRpcSessionInfoUpdateFrame(frame: unknown): frame is RpcSessionInfoUpdateFrame {
  return isRecord(frame) && frame.type === 'session_info_update';
}

function isRpcConfigUpdateFrame(frame: unknown): frame is RpcConfigUpdateFrame {
  return isRecord(frame) && frame.type === 'config_update';
}

function isRpcReadyFrame(frame: unknown): frame is RpcReadyFrame {
  return isRecord(frame) && frame.type === 'ready';
}

function buildRpcImages(attachments?: PendingAttachment[]): RpcImageContent[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    type: 'image',
    mimeType: attachment.mimeType || 'image/jpeg',
    data: Buffer.from(attachment.data).toString('base64'),
  }));
}

function extractToolError(result: unknown): boolean {
  return isRecord(result) && (result.isError === true || typeof result.error === 'string');
}

function extractTodoEntries(result: unknown): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> {
  if (!isRecord(result)) {
    return [];
  }
  const details = result.details;
  if (!isRecord(details)) {
    return [];
  }
  const phases = details.todoPhases;
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
      const content = asString(item.content)?.trim();
      const status = item.status;
      if (!content) {
        return [];
      }
      return [{
        content,
        status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      }];
    });
  });
}

function buildOmpRpcArgs(opts: RunOmpRpcOptions): string[] {
  const args = ['--allow-home', '--mode', 'rpc'];
  if (opts.yolo) {
    args.push('--yolo');
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  return args;
}

export async function runOmpRpc(opts: RunOmpRpcOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const localMode = opts.local !== false;
  const runMode: OmpRunMode = localMode ? 'local' : 'remote';
  const sessionTag = randomUUID();
  connectionState.setBackend('omp-rpc');

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
      logger.debug('[omp-rpc] Failed to report session to daemon:', error);
    }
  }

  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  let child: ChildProcessWithoutNullStreams | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;
  let pendingPromptId: string | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readySettled = false;
  let thinking = false;
  let turnStarted = false;
  let assistantTextEmitted = false;
  let ompPending = '';
  let ompPendingKind: 'output' | 'thinking' | null = null;
  let ompLastPlanJson = '';
  const pendingResponses = new Map<string, RpcPendingResponse>();

  const log = (message: string, data?: unknown) => {
    logger.debug(`[omp-rpc] ${message}`, data);
    if (verbose) {
      console.log(`[omp-rpc] ${message}`);
    }
  };

  const settleReady = (error?: Error) => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    if (error) {
      readyReject?.(error);
    } else {
      readyResolve?.();
    }
    readyResolve = null;
    readyReject = null;
  };

  const waitForReady = () => {
    if (readySettled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      setTimeout(() => {
        if (!readySettled) {
          settleReady(new Error('Timed out waiting for omp RPC ready frame'));
        }
      }, READY_TIMEOUT_MS);
    });
  };

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    pendingPromptId = null;
    if (error) {
      current.reject(error);
    } else {
      current.resolve();
    }
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingTurn = null;
      pendingPromptId = null;
      reject(new Error('Timed out waiting for omp RPC turn completion'));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  const flushOmpText = () => {
    const text = ompPending.trim();
    const kind = ompPendingKind;
    ompPending = '';
    ompPendingKind = null;
    if (!text || !kind) {
      return;
    }
    if (kind === 'thinking') {
      session.sendAgentMessage('omp', { type: 'thinking', text });
      return;
    }
    session.sendAgentMessage('omp', { type: 'message', message: text });
  };

  const appendOmpPending = (kind: 'output' | 'thinking', text: string) => {
    if (!text) {
      return;
    }
    if (ompPendingKind && ompPendingKind !== kind) {
      flushOmpText();
    }
    ompPendingKind = kind;
    ompPending += text;
  };

  const emitPlanTodos = (result: unknown) => {
    const todos = extractTodoEntries(result);
    const json = JSON.stringify(todos);
    if (todos.length === 0 && !ompLastPlanJson) {
      return;
    }
    ompLastPlanJson = json;
    flushOmpText();
    const planCall = `omp-plan-${randomUUID()}`;
    session.sendAgentMessage('omp', { type: 'tool-call', name: 'TodoWrite', callId: planCall, input: { todos }, id: randomUUID() });
    session.sendAgentMessage('omp', { type: 'tool-result', callId: planCall, output: { todos }, id: randomUUID() });
  };

  const publishRunMode = () => {
    session.sendSessionEvent({ type: 'switch', mode: runMode });
    session.updateAgentState((currentState) => ({
      ...currentState,
      controlledByUser: runMode === 'local',
    }));
    session.keepAlive(thinking, runMode);
  };

  const sendRpcCommand = <T extends RpcResponseFrame>(command: Record<string, unknown>): Promise<T> => {
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('omp RPC process stdin is not writable'));
    }
    const id = typeof command.id === 'string' ? command.id : randomUUID();
    command.id = id;
    return new Promise<T>((resolve, reject) => {
      pendingResponses.set(id, {
        command: String(command.type ?? 'unknown'),
        resolve: (frame) => resolve(frame as T),
        reject,
      });
      child!.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          pendingResponses.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  };

  const handleRpcResponse = (frame: RpcResponseFrame) => {
    const id = frame.id;
    if (!id) {
      return;
    }
    const pending = pendingResponses.get(id);
    if (!pending) {
      return;
    }
    pendingResponses.delete(id);
    if (!frame.success) {
      pending.reject(new Error(frame.error || `${pending.command} failed`));
      return;
    }
    pending.resolve(frame);
  };

  const handleAssistantMessageUpdate = (frame: RpcAgentEventFrame) => {
    if (!isAssistantMessage(frame.message) || !isRecord(frame.assistantMessageEvent)) {
      return;
    }
    const eventType = frame.assistantMessageEvent.type;
    if (eventType === 'text_delta') {
      const delta = asString(frame.assistantMessageEvent.delta) || '';
      if (delta.length > 0) {
        assistantTextEmitted = true;
        appendOmpPending('output', delta);
        if (localMode) {
          process.stdout.write(delta);
        }
      }
      return;
    }
    if (eventType === 'thinking_delta') {
      const delta = asString(frame.assistantMessageEvent.delta) || '';
      if (delta.length > 0) {
        appendOmpPending('thinking', delta);
        if (localMode) {
          process.stdout.write(`\x1b[2m${delta}\x1b[0m`);
        }
      }
      return;
    }
    if (eventType === 'error') {
      const errorMessage = isRecord(frame.assistantMessageEvent.error)
        ? asString(frame.assistantMessageEvent.error.errorMessage)
        : undefined;
      if (errorMessage) {
        assistantTextEmitted = true;
        appendOmpPending('output', errorMessage);
      }
    }
  };

  const handleRpcEvent = (frame: RpcAgentEventFrame) => {
    switch (frame.type) {
      case 'agent_start': {
        turnStarted = true;
        assistantTextEmitted = false;
        ompPending = '';
        ompPendingKind = null;
        ompLastPlanJson = '';
        thinking = true;
        session.keepAlive(thinking, runMode);
        session.sendAgentMessage('omp', { type: 'task_started', id: randomUUID() });
        return;
      }
      case 'message_update': {
        handleAssistantMessageUpdate(frame);
        return;
      }
      case 'message_end': {
        if (isAssistantMessage(frame.message) && !assistantTextEmitted) {
          const text = extractAssistantText(frame.message);
          if (text.length > 0) {
            appendOmpPending('output', text);
            assistantTextEmitted = true;
            if (localMode) {
              process.stdout.write(text);
            }
          }
        }
        return;
      }
      case 'tool_execution_start': {
        flushOmpText();
        const toolName = asString(frame.toolName) || 'tool';
        const toolCallId = asString(frame.toolCallId) || randomUUID();
        session.sendAgentMessage('omp', {
          type: 'tool-call',
          name: toolName,
          callId: toolCallId,
          input: frame.args,
          id: randomUUID(),
        });
        if (localMode) {
          process.stdout.write(`\n\x1b[2m⚙ ${toolName}\x1b[0m\n`);
        }
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = asString(frame.toolCallId) || randomUUID();
        const result = frame.result;
        session.sendAgentMessage('omp', {
          type: 'tool-result',
          callId: toolCallId,
          output: result,
          id: randomUUID(),
          isError: extractToolError(result),
        });
        emitPlanTodos(result);
        return;
      }
      case 'agent_end': {
        flushOmpText();
        turnStarted = false;
        thinking = false;
        session.keepAlive(false, runMode);
        session.sendAgentMessage('omp', { type: 'task_complete', id: randomUUID() });
        session.sendSessionEvent({ type: 'ready' });
        clearPendingTurn();
        if (localMode) {
          process.stdout.write(`\n\n${LOCAL_PROMPT}`);
        }
        return;
      }
      default:
        return;
    }
  };

  const handleRpcFrame = async (frame: unknown) => {
    if (isRpcReadyFrame(frame)) {
      settleReady();
      try {
        await sendRpcCommand({ type: 'set_subagent_subscription', level: 'events' });
      } catch (error) {
        log(`set_subagent_subscription failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (isRpcResponseFrame(frame)) {
      handleRpcResponse(frame);
      return;
    }

    if (isRpcPromptResultFrame(frame)) {
      if (frame.id === pendingPromptId && frame.agentInvoked === false) {
        session.sendSessionEvent({ type: 'ready' });
        clearPendingTurn();
        if (localMode) {
          process.stdout.write(`\n${LOCAL_PROMPT}`);
        }
      }
      return;
    }

    if (isRpcAvailableCommandsUpdateFrame(frame)) {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        slashCommands: frame.commands.map((command) => command.name),
      }));
      return;
    }

    if (isRpcSessionInfoUpdateFrame(frame)) {
      const title = asString(frame.title);
      if (title) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          name: title,
        }));
      }
      return;
    }

    if (isRpcConfigUpdateFrame(frame)) {
      return;
    }

    if (isRecord(frame) && typeof frame.type === 'string') {
      handleRpcEvent(frame as RpcAgentEventFrame);
    }
  };

  const rejectPendingResponses = (error: Error) => {
    for (const pending of pendingResponses.values()) {
      pending.reject(error);
    }
    pendingResponses.clear();
  };

  const handleAbort = async () => {
    if (pendingPromptId) {
      try {
        await sendRpcCommand({ type: 'abort' });
      } catch (error) {
        log(`abort command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    thinking = false;
    session.keepAlive(false, runMode);
    clearPendingTurn();
    abortController.abort();
    abortController = new AbortController();
  };

  const startRpcProcess = () => {
    const childArgs = buildOmpRpcArgs(opts);
    log(`Spawning omp ${childArgs.join(' ')}`);
    child = spawn('omp', childArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      void (async () => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        try {
          await handleRpcFrame(JSON.parse(trimmed));
        } catch (error) {
          log(`Failed to handle RPC frame: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) {
        logger.debug('[omp-rpc][stderr]', text);
        if (verbose) {
          console.log(`[omp-rpc][stderr] ${text.trimEnd()}`);
        }
      }
    });

    child.on('error', (error) => {
      settleReady(error instanceof Error ? error : new Error(String(error)));
      rejectPendingResponses(error instanceof Error ? error : new Error(String(error)));
      clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
      shouldExit = true;
      messageQueue.close();
    });

    child.on('exit', (code, signal) => {
      const reason = new Error(`omp RPC exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      settleReady(reason);
      rejectPendingResponses(reason);
      if (!shouldExit) {
        clearPendingTurn(reason);
        shouldExit = true;
        messageQueue.close();
      }
    });
  };

  session.onFileEvent((fileEvent) => {
    const ev = fileEvent.content.data.ev;
    const downloadPromise = (async (): Promise<PendingAttachment | null> => {
      try {
        const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
        if (!decrypted) {
          return null;
        }
        return {
          data: decrypted,
          mimeType: ev.mimeType ?? 'image/jpeg',
          name: ev.name,
        };
      } catch {
        return null;
      }
    })();
    session.trackAttachmentDownload(downloadPromise);
  });

  session.onUserMessage(async (message) => {
    const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
    if (!message.content.text && attachmentsForThisMessage.length === 0) {
      return;
    }
    messageQueue.push(message.content.text ?? '', {}, attachmentsForThisMessage);
  });

  if (localMode) {
    process.stdout.write(`\n\x1b[36mLocal omp RPC prototype — type below (also drivable from your phone). Ctrl-C to exit.\x1b[0m\n\n${LOCAL_PROMPT}`);
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (text) {
        messageQueue.push(text, {});
      } else {
        process.stdout.write(LOCAL_PROMPT);
      }
    });
  }

  publishRunMode();
  session.updateMetadata((currentMetadata) => ({
    ...currentMetadata,
    flavor: 'omp',
  }));

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, runMode);
  }, 2000);

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  });

  try {
    startRpcProcess();
    await waitForReady();

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!child) {
        throw new Error('omp RPC process not started');
      }

      const promptId = randomUUID();
      pendingPromptId = promptId;
      assistantTextEmitted = false;
      ompPending = '';
      ompPendingKind = null;
      ompLastPlanJson = '';
      const turnEnded = waitForTurnEnd();

      try {
        const command: RpcPromptCommand = {
          id: promptId,
          type: 'prompt',
          message: batch.message,
        };
        const images = buildRpcImages(batch.attachments);
        if (images && images.length > 0) {
          command.images = images;
        }
        await sendRpcCommand(command);
        await turnEnded;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        flushOmpText();
        if (turnStarted) {
          session.sendAgentMessage('omp', { type: 'turn_aborted', id: randomUUID() });
        }
        turnStarted = false;
        thinking = false;
        session.keepAlive(false, runMode);
        session.sendSessionEvent({ type: 'ready' });
        if (localMode) {
          process.stdout.write(`\n\x1b[31m${err.message}\x1b[0m\n${LOCAL_PROMPT}`);
        }
        clearPendingTurn(err);
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    rejectPendingResponses(new Error('OMP RPC runner shutting down'));
    clearPendingTurn(new Error('OMP RPC runner shutting down'));

    try {
      (child as unknown as { kill(signal?: string): boolean } | null)?.kill('SIGTERM');
    } catch (error) {
      logger.debug('[omp-rpc] Failed to terminate child process:', error);
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
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[omp-rpc] Session close failed:', error);
    }
  }
}
