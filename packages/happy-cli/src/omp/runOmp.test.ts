import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';

import type { Credentials } from '@/persistence';

type UserMessageHandler = (message: unknown) => Promise<void> | void;
type FileEventHandler = (message: unknown) => void;
type MetadataRecord = Record<string, unknown>;
type MetadataUpdater = (state: MetadataRecord) => MetadataRecord;
type AgentStateUpdater = (state: MetadataRecord) => MetadataRecord;
type PtyDataHandler = (data: string) => void;
type PtyExitHandler = (event: { exitCode: number; signal?: number }) => void;
type BridgeConnectionHandler = (socket: unknown) => void;
type BridgeDataHandler = (data: string) => void;
type BridgeEventHandler = (...args: unknown[]) => void;
type PendingAttachment = { data: Uint8Array; mimeType: string; name: string };

const mocks = vi.hoisted(() => {
  let userMessageHandler: UserMessageHandler | null = null;
  let fileEventHandler: FileEventHandler | null = null;
  let bridgeConnectionHandler: BridgeConnectionHandler | null = null;
  let listeningHandler: BridgeEventHandler | null = null;
  let killSessionHandler: (() => Promise<void>) | null = null;
  const bridgeDataHandlers = new Map<object, BridgeDataHandler>();
  const bridgeCloseHandlers = new Map<object, BridgeEventHandler>();

  const createBridgeSocket = () => {
    const socket = {
      writable: true,
      setEncoding: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: BridgeEventHandler) => {
        if (event === 'data') bridgeDataHandlers.set(socket, handler as BridgeDataHandler);
        if (event === 'close') bridgeCloseHandlers.set(socket, handler);
        return socket;
      }),
    };
    return socket;
  };
  const mockBridgeSocket = createBridgeSocket();
  const mockNetServer = {
    once: vi.fn((event: string, handler: BridgeEventHandler) => {
      if (event === 'listening') listeningHandler = handler;
      return mockNetServer;
    }),
    off: vi.fn(() => mockNetServer),
    listen: vi.fn(() => {
      listeningHandler?.();
      return mockNetServer;
    }),
    close: vi.fn((callback?: () => void) => {
      callback?.();
      return mockNetServer;
    }),
  };
  const mockCreateServer = vi.fn((handler: BridgeConnectionHandler) => {
    bridgeConnectionHandler = handler;
    return mockNetServer;
  });
  const mockSession = {
    onUserMessage: vi.fn((handler: UserMessageHandler) => {
      userMessageHandler = handler;
    }),
    onFileEvent: vi.fn((handler: FileEventHandler) => {
      fileEventHandler = handler;
    }),
    drainAttachmentsForUserMessage: vi.fn(async (): Promise<PendingAttachment[]> => []),
    trackAttachmentDownload: vi.fn(),
    downloadAndDecryptAttachment: vi.fn(),
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn((handler: MetadataUpdater) => {
      handler({});
    }),
    updateAgentState: vi.fn((handler: AgentStateUpdater) => {
      handler({});
    }),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rpcHandlerManager: {
      registerHandler: vi.fn(),
    },
  };

  return {
    mockSpawnPty: vi.fn(),
    mockMkdtemp: vi.fn(),
    mockRm: vi.fn(),
    mockCreateServer,
    mockBridgeSocket,
    mockApiCreate: vi.fn(),
    mockGetOrCreateMachine: vi.fn(async () => ({})),
    mockGetOrCreateSession: vi.fn(async () => undefined),
    mockReadSettings: vi.fn(async () => ({ machineId: 'machine-1', sandboxConfig: undefined })),
    mockCreateSessionMetadata: vi.fn(() => ({ state: { started: true }, metadata: { path: '/repo' } })),
    mockSetupOfflineReconnection: vi.fn(),
    mockNotifyDaemonSessionStarted: vi.fn(async () => ({ error: null })),
    mockNotifyDaemonSessionTitle: vi.fn(async () => ({ error: null })),
    mockRegisterKillSessionHandler: vi.fn((_manager: unknown, handler: () => Promise<void>) => {
      killSessionHandler = handler;
    }),
    mockSetBackend: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockCancel: vi.fn(),
    mockSession,
    getUserMessageHandler: () => userMessageHandler,
    getFileEventHandler: () => fileEventHandler,
    getKillSessionHandler: () => killSessionHandler,
    connectBridgeSocket: () => {
      const socket = createBridgeSocket();
      bridgeConnectionHandler?.(socket);
      return socket;
    },
    emitBridgeFrame: (frame: unknown) => {
      if (!bridgeDataHandlers.has(mockBridgeSocket)) bridgeConnectionHandler?.(mockBridgeSocket);
      bridgeDataHandlers.get(mockBridgeSocket)?.(`${JSON.stringify(frame)}\n`);
    },
    emitBridgeFrameOn: (socket: object, frame: unknown) => {
      bridgeDataHandlers.get(socket)?.(`${JSON.stringify(frame)}\n`);
    },
    emitBridgeClose: (socket: object) => {
      bridgeCloseHandlers.get(socket)?.();
    },
    resetHandlers: () => {
      userMessageHandler = null;
      fileEventHandler = null;
      bridgeConnectionHandler = null;
      bridgeDataHandlers.clear();
      bridgeCloseHandlers.clear();
      listeningHandler = null;
      killSessionHandler = null;
    },
  };
});

vi.mock('node-pty', () => ({
  spawn: mocks.mockSpawnPty,
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mockMkdtemp,
  rm: mocks.mockRm,
}));

vi.mock('node:net', () => ({
  createServer: mocks.mockCreateServer,
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.mockApiCreate,
  },
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
  registerKillSessionHandler: mocks.mockRegisterKillSessionHandler,
}));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonSessionStarted: mocks.mockNotifyDaemonSessionStarted,
  notifyDaemonSessionTitle: mocks.mockNotifyDaemonSessionTitle,
}));

vi.mock('@/daemon/run', () => ({
  initialMachineMetadata: {
    host: 'host',
    platform: 'linux',
    happyCliVersion: 'test',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happy',
    happyLibDir: '/tmp/happy',
  },
}));

vi.mock('@/persistence', () => ({
  readSettings: mocks.mockReadSettings,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}));

vi.mock('@/utils/createSessionMetadata', () => ({
  createSessionMetadata: mocks.mockCreateSessionMetadata,
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
  connectionState: {
    setBackend: mocks.mockSetBackend,
  },
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
  setupOfflineReconnection: mocks.mockSetupOfflineReconnection,
}));


import { runOmp } from './runOmp';

class FakePty {
  private dataHandler: PtyDataHandler | null = null;
  private exitHandler: PtyExitHandler | null = null;

  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn((_signal?: string | number) => {});
  onData = vi.fn((handler: PtyDataHandler) => {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  });
  onExit = vi.fn((handler: PtyExitHandler) => {
    this.exitHandler = handler;
    return { dispose: vi.fn() };
  });

  emitData(data: string): void {
    this.dataHandler?.(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    this.exitHandler?.({ exitCode, signal });
  }
}

const credentials: Credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3, 4]),
  },
};

let child: FakePty;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}


async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe('runOmp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();

    child = new FakePty();
    mocks.resetHandlers();

    mocks.mockMkdtemp.mockResolvedValue('/tmp/happy-omp-test');
    mocks.mockRm.mockResolvedValue(undefined);
    mocks.mockSpawnPty.mockImplementation(() => child);
    mocks.mockApiCreate.mockResolvedValue({
      getOrCreateMachine: mocks.mockGetOrCreateMachine,
      getOrCreateSession: mocks.mockGetOrCreateSession,
    });
    mocks.mockSetupOfflineReconnection.mockReturnValue({
      session: mocks.mockSession,
      reconnectionHandle: {
        cancel: mocks.mockCancel,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('reconnects the native OMP bridge to the existing Happy session', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'happy-session-existing');
    vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_KEY', Buffer.from([1, 2, 3, 4]).toString('base64'));
    vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'legacy');
    vi.stubEnv('HAPPY_RECONNECT_SEQ', '7');
    vi.stubEnv('HAPPY_RECONNECT_METADATA_VERSION', '8');
    vi.stubEnv('HAPPY_RECONNECT_AGENT_STATE_VERSION', '9');

    const runPromise = runOmp({
      credentials,
      extraArgs: ['--resume', 'omp-session-existing'],
    });
    await settleMicrotasks();

    expect(mocks.mockGetOrCreateSession).not.toHaveBeenCalled();
    expect(mocks.mockSetupOfflineReconnection).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({
        id: 'happy-session-existing',
        seq: 7,
        metadataVersion: 8,
        agentStateVersion: 9,
      }),
    }));
    expect(mocks.mockSpawnPty).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[/\\])omp(?:\.exe)?$/),
      expect.arrayContaining(['--resume', 'omp-session-existing']),
      expect.objectContaining({ cwd: process.cwd() }),
    );

    mocks.emitBridgeFrame({
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-session-existing',
    });
    await vi.advanceTimersByTimeAsync(1);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('launches native omp through node-pty with the bundled extension bridge', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({
      credentials,
      extraArgs: ['--model', 'test-model'],
    });

    await settleMicrotasks();

    expect(mocks.mockSpawnPty).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[/\\])omp(?:\.exe)?$/),
      ['--allow-home', '--extension', expect.stringMatching(/scripts\/omp-happy-bridge\.mjs$/), '--model', 'test-model', '--config', expect.stringMatching(/scripts\/omp-happy-config\.overlay\.yml$/)],
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          OMP_HAPPY_BRIDGE_SOCKET: '/tmp/happy-omp-test/bridge.sock',
          OMP_HAPPY_CONTROL_MODE: 'remote',
          OMP_HAPPY_REAL_BIN: expect.stringMatching(/(?:^|[/\\])omp(?:\.exe)?$/),
        }),
        name: expect.any(String),
        cols: expect.any(Number),
        rows: expect.any(Number),
      }),
    );
    expect(child.onData).toHaveBeenCalledTimes(1);
    expect(child.onExit).toHaveBeenCalledTimes(1);

    mocks.emitBridgeFrame({
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-session-1',
      models: [
        { code: 'openai/gpt-5.6-sol', value: 'GPT-5.6 Sol' },
        { code: 'anthropic/claude-opus-4-6', value: 'Claude Opus 4.6', description: 'Most capable' },
      ],
      currentModel: 'openai/gpt-5.6-sol',
      modelRoles: {
        default: 'openai/gpt-5.6-sol:high',
        task: 'anthropic/claude-opus-4-6:low',
      },
      thoughtLevels: [
        { code: 'off', value: 'Off' },
        { code: 'high', value: 'High' },
      ],
      currentThoughtLevel: 'high',
      title: 'Native OMP title',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.mockSession.updateMetadata).toHaveBeenCalledWith(expect.any(Function));
    const readyMetadataUpdater = mocks.mockSession.updateMetadata.mock.calls[1]?.[0];
    expect(readyMetadataUpdater?.({ path: '/repo', flavor: 'omp' })).toMatchObject({
      path: '/repo',
      flavor: 'omp',
      ompSessionId: 'omp-session-1',
    });
    expect(readyMetadataUpdater?.({ path: '/repo', flavor: 'omp' })).toMatchObject({
      models: [
        { code: 'openai/gpt-5.6-sol', value: 'GPT-5.6 Sol' },
        { code: 'anthropic/claude-opus-4-6', value: 'Claude Opus 4.6', description: 'Most capable' },
      ],
      currentModelCode: 'openai/gpt-5.6-sol',
      modelRoles: {
        default: 'openai/gpt-5.6-sol:high',
        task: 'anthropic/claude-opus-4-6:low',
      },
      thoughtLevels: [
        { code: 'off', value: 'Off' },
        { code: 'high', value: 'High' },
      ],
      currentThoughtLevelCode: 'high',
    });
    const nativeTitleUpdater = mocks.mockSession.updateMetadata.mock.calls[2]?.[0];
    expect(nativeTitleUpdater?.({ path: '/repo' })).toMatchObject({
      summary: {
        text: 'Native OMP title',
        updatedAt: expect.any(Number),
      },
    });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('forwards OMP bridge usage as the exact shared token_count payload', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-usage' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.mockSession.sendAgentMessage.mockClear();

    mocks.emitBridgeFrame({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 23,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
      contextTokens: 97_654,
      contextWindow: 262_144,
      contextPercent: 37.25,
      tokensPerSecond: 18.5,
    });

    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledOnce();
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith('omp', {
      type: 'token_count',
      input_tokens: 11,
      output_tokens: 23,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 7,
      context_tokens: 97_654,
      context_window: 262_144,
      context_percent: 37.25,
      tokens_per_second: 18.5,
      id: expect.any(String),
    });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('keeps a normally exited OMP session visible and resumable', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-normal-exit' });
    await vi.advanceTimersByTimeAsync(1);
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    const metadataUpdates = mocks.mockSession.updateMetadata.mock.calls
      .map(([update]) => update({ path: '/repo' }));
    expect(metadataUpdates).not.toContainEqual(expect.objectContaining({
      lifecycleState: 'archived',
    }));
    expect(mocks.mockSession.sendSessionDeath).toHaveBeenCalledOnce();
  });

  it('archives an OMP session only when the app explicitly kills it', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-explicit-kill' });
    await vi.advanceTimersByTimeAsync(1);
    const killSession = mocks.getKillSessionHandler();
    expect(killSession).toBeTypeOf('function');
    await killSession?.();
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    const metadataUpdates = mocks.mockSession.updateMetadata.mock.calls
      .map(([update]) => update({ path: '/repo' }));
    expect(metadataUpdates).toContainEqual(expect.objectContaining({
      lifecycleState: 'archived',
      archivedBy: 'cli',
    }));
  });

  it('updates the Happy app title from the OMP change_title tool', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-title' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'change_title', title: 'Image upload repair' });

    const titleUpdater = mocks.mockSession.updateMetadata.mock.calls.at(-1)?.[0];
    expect(titleUpdater?.({
      path: '/repo',
      summary: { text: 'Old title', updatedAt: 1 },
    })).toEqual({
      path: '/repo',
      summary: {
        text: 'Image upload repair',
        updatedAt: expect.any(Number),
      },
    });
    expect(mocks.mockNotifyDaemonSessionTitle).toHaveBeenCalledWith(process.pid, 'Image upload repair');

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('renames an active OMP session from the Happy app', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-title' });
    await vi.advanceTimersByTimeAsync(1);
    const registration = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls
      .find((call) => call[0] === 'change-title');
    expect(registration).toBeDefined();

    await expect(registration?.[1]({ title: '  Renamed from phone  ' })).resolves.toEqual({ success: true });
    const titleUpdater = mocks.mockSession.updateMetadata.mock.calls.at(-1)?.[0];
    expect(titleUpdater?.({ path: '/repo' })).toEqual({
      path: '/repo',
      summary: {
        text: 'Renamed from phone',
        updatedAt: expect.any(Number),
      },
    });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"set_title","title":"Renamed from phone"}\n',
    );

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('sends a phone prompt without changing the shared control mode', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-1' });
    await vi.advanceTimersByTimeAsync(1);

    const userMessageHandler = mocks.getUserMessageHandler();
    expect(userMessageHandler).toBeTypeOf('function');
    await userMessageHandler?.({
      content: { text: 'Prompt from phone' },
    });

    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledWith({ type: 'switch', mode: 'remote' });
    expect(child.write).not.toHaveBeenCalled();
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith('{"type":"prompt","text":"Prompt from phone","images":[]}\n');
    const abortHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'abort',
    )?.[1] as (() => Promise<void>) | undefined;
    expect(abortHandler).toBeTypeOf('function');
    await abortHandler?.();
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith('{"type":"abort"}\n');

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('routes mid-flight phone prompts as steering on the root bridge', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-session' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.mockBridgeSocket.write.mockClear();
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'agent_start' },
    });
    const childSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(childSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-child-session',
    });
    mocks.emitBridgeFrameOn(childSocket, {
      type: 'agent_event',
      event: { type: 'agent_start' },
    });

    await mocks.getUserMessageHandler()?.({
      content: { text: 'Correction from phone' },
      meta: { model: 'openai/gpt-5.6-sol', effort: 'high' },
    });

    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"prompt","text":"Correction from phone","deliverAs":"steer","images":[]}\n',
    );
    expect(childSocket.write).not.toHaveBeenCalled();
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledTimes(1);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('attaches concurrent child streams by progress id rather than socket order', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-sidechains' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'delegate-parent',
        toolName: 'task',
        args: {
          tasks: [
            { name: 'AlphaWorker', task: 'Handle alpha' },
            { name: 'BetaWorker', task: 'Handle beta' },
          ],
        },
      },
    });

    const delegateMessage = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .find((message) => isRecord(message) && message.type === 'tool-call' && message.callId === 'delegate-parent');
    if (!isRecord(delegateMessage) || !isRecord(delegateMessage.input) || !Array.isArray(delegateMessage.input.tasks)) {
      throw new Error('Expected normalized delegate task input');
    }
    const alphaTask = delegateMessage.input.tasks[0];
    const betaTask = delegateMessage.input.tasks[1];
    if (!isRecord(alphaTask) || !isRecord(betaTask)) throw new Error('Expected two delegate tasks');
    const alphaSubagent = alphaTask.sessionSubagent;
    const betaSubagent = betaTask.sessionSubagent;
    expect(typeof alphaSubagent === 'string' && isCuid(alphaSubagent)).toBe(true);
    expect(typeof betaSubagent === 'string' && isCuid(betaSubagent)).toBe(true);
    expect(alphaSubagent).not.toBe(betaSubagent);

    const betaSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(betaSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-child-beta',
      sessionFile: '/tmp/root/BetaWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(betaSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'beta-message',
          content: [
            { type: 'thinking', thinking: 'Beta reasoning' },
            { type: 'text', text: 'Beta finished' },
          ],
        },
      },
    });
    const alphaSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(alphaSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-child-alpha',
      sessionFile: '/tmp/root/AlphaWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(alphaSocket, {
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'shared-tool-id',
        toolName: 'read',
        args: { path: '/tmp/alpha.ts' },
      },
    });
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalled();

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'delegate-parent',
        toolName: 'task',
        partialResult: {
          details: {
            progress: [
              { index: 1, id: 'BetaWorker', status: 'running' },
              { index: 0, id: 'AlphaWorker', status: 'running' },
            ],
          },
        },
      },
    });
    mocks.emitBridgeFrameOn(alphaSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'alpha-message',
          content: [{ type: 'text', text: 'Alpha finished' }],
        },
      },
    });
    mocks.emitBridgeFrameOn(alphaSocket, {
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'shared-tool-id',
        toolName: 'read',
        result: { ok: true },
      },
    });
    mocks.emitBridgeFrameOn(betaSocket, { type: 'agent_event', event: { type: 'session_shutdown' } });
    mocks.emitBridgeFrameOn(alphaSocket, { type: 'agent_event', event: { type: 'session_shutdown' } });

    const envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagent: alphaSubagent, ev: { t: 'start', title: 'AlphaWorker' } }),
      expect.objectContaining({ subagent: betaSubagent, ev: { t: 'start', title: 'BetaWorker' } }),
      expect.objectContaining({ subagent: alphaSubagent, ev: { t: 'text', text: 'Alpha finished' } }),
      expect.objectContaining({ subagent: betaSubagent, ev: { t: 'text', text: 'Beta reasoning', thinking: true } }),
      expect.objectContaining({ subagent: betaSubagent, ev: { t: 'text', text: 'Beta finished' } }),
      expect.objectContaining({ subagent: alphaSubagent, ev: { t: 'stop' } }),
      expect.objectContaining({ subagent: betaSubagent, ev: { t: 'stop' } }),
    ]));
    const childToolStart = envelopes.find((envelope) => (
      envelope.subagent === alphaSubagent
      && isRecord(envelope.ev)
      && envelope.ev.t === 'tool-call-start'
    ));
    expect(isRecord(childToolStart?.ev) ? childToolStart.ev.call : undefined)
      .toBe(`omp-child:${alphaSubagent}:shared-tool-id`);

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: 'delegate-parent', toolName: 'task', result: {} },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('recursively binds a grandchild that connects before its parent mapping replays', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-recursive' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'root-delegate',
        toolName: 'task',
        args: { tasks: [{ name: 'ParentWorker', task: 'Spawn nested work' }] },
      },
    });

    const rootDelegate = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .find((message) => isRecord(message) && message.type === 'tool-call' && message.callId === 'root-delegate');
    if (!isRecord(rootDelegate) || !isRecord(rootDelegate.input) || !Array.isArray(rootDelegate.input.tasks)) {
      throw new Error('Expected root delegate input');
    }
    const parentTask = rootDelegate.input.tasks[0];
    if (!isRecord(parentTask) || typeof parentTask.sessionSubagent !== 'string') {
      throw new Error('Expected parent session subagent');
    }
    const parentSubagent = parentTask.sessionSubagent;

    const parentSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(parentSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-parent-worker',
      sessionFile: '/tmp/root/ParentWorker.jsonl',
    });
    const grandchildSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(grandchildSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-grand-worker',
      sessionFile: '/tmp/root/ParentWorker/ParentWorker.GrandWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(grandchildSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'grandchild-output',
          content: [{ type: 'text', text: 'Grandchild finished' }],
        },
      },
    });
    mocks.emitBridgeFrameOn(parentSocket, {
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'nested-delegate',
        toolName: 'task',
        args: { tasks: [{ name: 'GrandWorker', task: 'Do nested work' }] },
      },
    });
    mocks.emitBridgeFrameOn(parentSocket, {
      type: 'subagent_lifecycle',
      payload: {
        id: 'ParentWorker.GrandWorker',
        parentToolCallId: 'nested-delegate',
        index: 0,
        status: 'started',
        sessionFile: '/tmp/root/ParentWorker/ParentWorker.GrandWorker.jsonl',
        detached: true,
      },
    });
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalled();

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'root-delegate',
        toolName: 'task',
        partialResult: {
          details: { progress: [{ index: 0, id: 'ParentWorker', status: 'running' }] },
        },
      },
    });

    const envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    const nestedDelegate = envelopes.find((envelope) => (
      envelope.subagent === parentSubagent
      && isRecord(envelope.ev)
      && envelope.ev.t === 'tool-call-start'
      && envelope.ev.name === 'delegate_task'
    ));
    if (!isRecord(nestedDelegate?.ev) || !isRecord(nestedDelegate.ev.args) || !Array.isArray(nestedDelegate.ev.args.tasks)) {
      throw new Error('Expected nested delegate envelope');
    }
    const grandchildTask = nestedDelegate.ev.args.tasks[0];
    if (!isRecord(grandchildTask) || typeof grandchildTask.sessionSubagent !== 'string') {
      throw new Error('Expected grandchild session subagent');
    }
    const grandchildSubagent = grandchildTask.sessionSubagent;
    expect(isCuid(grandchildSubagent)).toBe(true);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagent: parentSubagent, ev: { t: 'start', title: 'ParentWorker' } }),
      expect.objectContaining({ subagent: grandchildSubagent, ev: { t: 'start', title: 'GrandWorker' } }),
      expect.objectContaining({ subagent: grandchildSubagent, ev: { t: 'text', text: 'Grandchild finished' } }),
    ]));

    mocks.emitBridgeFrameOn(parentSocket, {
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'nested-delegate',
        toolName: 'task',
        result: {},
      },
    });
    mocks.emitBridgeFrameOn(parentSocket, {
      type: 'subagent_lifecycle',
      payload: {
        id: 'ParentWorker.GrandWorker',
        parentToolCallId: 'nested-delegate',
        index: 0,
        status: 'completed',
        sessionFile: '/tmp/root/ParentWorker/ParentWorker.GrandWorker.jsonl',
        detached: true,
      },
    });
    mocks.emitBridgeFrameOn(parentSocket, { type: 'agent_event', event: { type: 'session_shutdown' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: 'root-delegate', toolName: 'task', result: {} },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    const finalEnvelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(finalEnvelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagent: grandchildSubagent, ev: { t: 'stop' } }),
      expect.objectContaining({ subagent: grandchildSubagent, ev: { t: 'turn-end', status: 'completed' } }),
      expect.objectContaining({ subagent: parentSubagent, ev: { t: 'stop' } }),
    ]));

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('continues relaying a detached child after the parent delegate tool and turn end', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-detached' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'detached-delegate',
        toolName: 'task',
        args: { tasks: [{ name: 'DetachedWorker', task: 'Keep working' }] },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'detached-delegate',
        toolName: 'task',
        partialResult: {
          details: { progress: [{ index: 0, id: 'DetachedWorker', status: 'running' }] },
        },
      },
    });
    const delegateMessage = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .find((message) => isRecord(message) && message.type === 'tool-call' && message.callId === 'detached-delegate');
    if (!isRecord(delegateMessage) || !isRecord(delegateMessage.input) || !Array.isArray(delegateMessage.input.tasks)) {
      throw new Error('Expected detached delegate input');
    }
    const detachedTask = delegateMessage.input.tasks[0];
    if (!isRecord(detachedTask) || typeof detachedTask.sessionSubagent !== 'string') {
      throw new Error('Expected detached session subagent');
    }
    const detachedSubagent = detachedTask.sessionSubagent;

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'detached-delegate',
        toolName: 'task',
        result: {},
      },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });

    const detachedSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(detachedSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-detached-worker',
      sessionFile: '/tmp/root/DetachedWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(detachedSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          id: 'detached-message',
          content: [{ type: 'text', text: 'Detached output after parent completion' }],
        },
      },
    });
    mocks.emitBridgeFrameOn(detachedSocket, {
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'detached-tool',
        toolName: 'read',
        args: { path: '/tmp/detached.ts' },
      },
    });
    mocks.emitBridgeFrameOn(detachedSocket, {
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: 'detached-tool', toolName: 'read', result: {} },
    });
    mocks.emitBridgeFrameOn(detachedSocket, { type: 'agent_event', event: { type: 'agent_end' } });

    let envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subagent: detachedSubagent,
        ev: { t: 'text', text: 'Detached output after parent completion' },
      }),
      expect.objectContaining({
        subagent: detachedSubagent,
        ev: expect.objectContaining({ t: 'tool-call-start', name: 'read' }),
      }),
    ]));
    expect(envelopes.some((envelope) => (
      envelope.subagent === detachedSubagent && isRecord(envelope.ev) && envelope.ev.t === 'stop'
    ))).toBe(false);

    mocks.emitBridgeFrame({
      type: 'subagent_lifecycle',
      payload: {
        id: 'DetachedWorker',
        parentToolCallId: 'detached-delegate',
        index: 0,
        status: 'completed',
        sessionFile: '/tmp/root/DetachedWorker.jsonl',
        detached: true,
      },
    });
    envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subagent: detachedSubagent,
        ev: { t: 'turn-end', status: 'completed' },
      }),
    ]));
    expect(envelopes.some((envelope) => (
      envelope.subagent === detachedSubagent && isRecord(envelope.ev) && envelope.ev.t === 'stop'
    ))).toBe(true);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it.each([
    ['failed', 'failed'],
    ['aborted', 'cancelled'],
  ] as const)('uses terminal lifecycle %s after a default-detached parent tool ends', async (lifecycleStatus, turnStatus) => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    const workerName = lifecycleStatus === 'failed' ? 'FailedWorker' : 'AbortedWorker';
    const callId = `detached-${lifecycleStatus}`;

    mocks.emitBridgeFrame({
      type: 'ready',
      protocolVersion: 1,
      sessionId: `omp-root-${lifecycleStatus}`,
    });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: callId,
        toolName: 'task',
        args: { tasks: [{ name: workerName, task: 'Finish after the parent turn' }] },
      },
    });
    const delegateMessage = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .find((message) => isRecord(message) && message.type === 'tool-call' && message.callId === callId);
    if (!isRecord(delegateMessage) || !isRecord(delegateMessage.input) || !Array.isArray(delegateMessage.input.tasks)) {
      throw new Error('Expected detached delegate input');
    }
    const task = delegateMessage.input.tasks[0];
    if (!isRecord(task) || typeof task.sessionSubagent !== 'string') {
      throw new Error('Expected detached session subagent');
    }
    const subagent = task.sessionSubagent;

    const childSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(childSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: `omp-child-${lifecycleStatus}`,
      sessionFile: `/tmp/root/${workerName}.jsonl`,
    });
    mocks.emitBridgeFrameOn(childSocket, { type: 'agent_event', event: { type: 'agent_end' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: callId, toolName: 'task', result: {} },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    mocks.emitBridgeFrame({
      type: 'subagent_lifecycle',
      payload: {
        id: workerName,
        parentToolCallId: callId,
        index: 0,
        status: lifecycleStatus,
        sessionFile: `/tmp/root/${workerName}.jsonl`,
        detached: true,
      },
    });

    const envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagent, ev: { t: 'start', title: workerName } }),
      expect.objectContaining({ subagent, ev: { t: 'turn-end', status: turnStatus } }),
      expect.objectContaining({ subagent, ev: { t: 'stop' } }),
    ]));

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('keeps a child mapping across transient socket reconnect without duplicate lifecycle markers', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-reconnect' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'reconnect-delegate',
        toolName: 'task',
        args: { tasks: [{ name: 'ReconnectWorker', task: 'Survive reconnect' }] },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'reconnect-delegate',
        toolName: 'task',
        partialResult: {
          details: { progress: [{ index: 0, id: 'ReconnectWorker', status: 'running' }] },
        },
      },
    });
    const delegateMessage = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .find((message) => isRecord(message) && message.type === 'tool-call' && message.callId === 'reconnect-delegate');
    if (!isRecord(delegateMessage) || !isRecord(delegateMessage.input) || !Array.isArray(delegateMessage.input.tasks)) {
      throw new Error('Expected reconnect delegate input');
    }
    const reconnectTask = delegateMessage.input.tasks[0];
    if (!isRecord(reconnectTask) || typeof reconnectTask.sessionSubagent !== 'string') {
      throw new Error('Expected reconnect session subagent');
    }
    const reconnectSubagent = reconnectTask.sessionSubagent;

    const firstSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(firstSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-reconnect-worker',
      sessionFile: '/tmp/root/ReconnectWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(firstSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: { role: 'assistant', id: 'before-reconnect', content: [{ type: 'text', text: 'Before reconnect' }] },
      },
    });
    mocks.emitBridgeClose(firstSocket);

    let envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    expect(envelopes.some((envelope) => (
      envelope.subagent === reconnectSubagent && isRecord(envelope.ev) && envelope.ev.t === 'stop'
    ))).toBe(false);

    const secondSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(secondSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'omp-reconnect-worker',
      sessionFile: '/tmp/root/ReconnectWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(secondSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: { role: 'assistant', id: 'after-reconnect', content: [{ type: 'text', text: 'After reconnect' }] },
      },
    });
    mocks.emitBridgeFrameOn(secondSocket, { type: 'agent_event', event: { type: 'session_shutdown' } });

    envelopes = mocks.mockSession.sendSessionProtocolMessage.mock.calls
      .map((call) => call[0])
      .filter(isRecord);
    const lifecycle = envelopes.filter((envelope) => (
      envelope.subagent === reconnectSubagent
      && isRecord(envelope.ev)
      && (envelope.ev.t === 'start' || envelope.ev.t === 'stop')
    ));
    expect(lifecycle.filter((envelope) => isRecord(envelope.ev) && envelope.ev.t === 'start')).toHaveLength(1);
    expect(lifecycle.filter((envelope) => isRecord(envelope.ev) && envelope.ev.t === 'stop')).toHaveLength(1);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subagent: reconnectSubagent, ev: { t: 'text', text: 'Before reconnect' } }),
      expect.objectContaining({ subagent: reconnectSubagent, ev: { t: 'text', text: 'After reconnect' } }),
    ]));

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: 'reconnect-delegate', toolName: 'task', result: {} },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('drops unmatched, duplicate, and metadata-free child streams', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-root-rejections' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'delegate-rejections',
        toolName: 'task',
        args: { tasks: [{ name: 'ExpectedWorker', task: 'Expected task' }] },
      },
    });

    for (const sessionId of ['duplicate-a', 'duplicate-b']) {
      const socket = mocks.connectBridgeSocket();
      mocks.emitBridgeFrameOn(socket, {
        type: 'ready',
        protocolVersion: 1,
        sessionId,
        sessionFile: '/tmp/root/ExpectedWorker.jsonl',
      });
      mocks.emitBridgeFrameOn(socket, {
        type: 'agent_event',
        event: {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: sessionId }] },
        },
      });
    }
    const unmatchedSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(unmatchedSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'unmatched',
      sessionFile: '/tmp/root/OtherWorker.jsonl',
    });
    mocks.emitBridgeFrameOn(unmatchedSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'unmatched output' }] },
      },
    });
    const metadataFreeSocket = mocks.connectBridgeSocket();
    mocks.emitBridgeFrameOn(metadataFreeSocket, {
      type: 'ready',
      protocolVersion: 1,
      sessionId: 'metadata-free',
    });
    mocks.emitBridgeFrameOn(metadataFreeSocket, {
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'metadata-free output' }] },
      },
    });

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'delegate-rejections',
        toolName: 'task',
        partialResult: {
          details: { progress: [{ index: 0, id: 'ExpectedWorker', status: 'running' }] },
        },
      },
    });
    expect(mocks.mockSession.sendSessionProtocolMessage).not.toHaveBeenCalled();

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'tool_execution_end', toolCallId: 'delegate-rejections', toolName: 'task', result: {} },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('queues a phone prompt received while stop is completing', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-abort-queue' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.mockBridgeSocket.write.mockClear();
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });

    const abortHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'abort',
    )?.[1] as (() => Promise<void>) | undefined;
    await abortHandler?.();
    await mocks.getUserMessageHandler()?.({
      content: { text: 'Run after stop' },
      meta: { model: 'openai/gpt-5.6-sol', effort: 'high' },
    });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledTimes(1);
    expect(mocks.mockBridgeSocket.write).toHaveBeenLastCalledWith('{"type":"abort"}\n');

    mocks.emitBridgeFrame({ type: 'aborted' });
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      2,
      '{"type":"set_model_role","role":"default","spec":"openai/gpt-5.6-sol"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      3,
      '{"type":"set_thinking_level","level":"high"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      4,
      '{"type":"prompt","text":"Run after stop","images":[]}\n',
    );

    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    const taskCompleteCalls = mocks.mockSession.sendAgentMessage.mock.calls.filter(
      ([, message]) => message.type === 'task_complete',
    );
    expect(taskCompleteCalls).toHaveLength(1);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });


  it('routes phone images and model selection through the extension bridge', async () => {
    vi.useFakeTimers();
    mocks.mockSession.drainAttachmentsForUserMessage.mockResolvedValueOnce([
      { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'screen.png' },
    ]);

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-images' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.mockBridgeSocket.write.mockClear();

    const userMessageHandler = mocks.getUserMessageHandler();
    await userMessageHandler?.({
      content: { text: '' },
      meta: { model: 'openai/gpt-5.6-sol', effort: 'high' },
    });

    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      1,
      '{"type":"set_model_role","role":"default","spec":"openai/gpt-5.6-sol"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      2,
      '{"type":"set_thinking_level","level":"high"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      3,
      '{"type":"prompt","text":"","images":[{"data":"AQID","mimeType":"image/png"}]}\n',
    );

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });
  it('attributes extension-injected input without duplicating the phone prompt', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-1' });
    await vi.advanceTimersByTimeAsync(1);

    const userMessageHandler = mocks.getUserMessageHandler();
    expect(userMessageHandler).toBeTypeOf('function');
    await userMessageHandler?.({
      content: { text: 'Prompt from phone' },
    });

    mocks.emitBridgeFrame({
      type: 'input',
      source: 'extension',
      text: 'Prompt from phone',
    });
    mocks.emitBridgeFrame({
      type: 'input',
      source: 'interactive',
      text: 'A later local prompt',
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.mockSession.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    const forwardedEnvelope = mocks.mockSession.sendSessionProtocolMessage.mock.calls[0]?.[0];
    expect(isRecord(forwardedEnvelope)).toBe(true);
    if (!isRecord(forwardedEnvelope)) {
      throw new Error('Expected only the interactive prompt to be forwarded');
    }
    expect(forwardedEnvelope.role).toBe('user');
    expect(forwardedEnvelope.ev).toEqual({ t: 'text', text: 'A later local prompt' });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('streams terminal input attribution and assistant output into the session', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-1' });
    await vi.advanceTimersByTimeAsync(1);

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'agent_start' },
    });
    mocks.emitBridgeFrame({
      type: 'input',
      source: 'interactive',
      text: 'Write focused tests',
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'terminal-call-1',
        toolName: 'bash',
        args: { command: 'printf hello' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'terminal-call-1',
        result: { content: [{ type: 'text', text: 'hello' }] },
        isError: false,
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: { type: 'agent_end' },
    });

    await vi.advanceTimersByTimeAsync(100);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    expect(mocks.mockSession.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    const firstEnvelope = mocks.mockSession.sendSessionProtocolMessage.mock.calls[0]?.[0];
    expect(isRecord(firstEnvelope)).toBe(true);
    if (!isRecord(firstEnvelope)) {
      throw new Error('Expected a user session envelope from attributed terminal input');
    }
    expect(firstEnvelope.role).toBe('user');
    expect(firstEnvelope.ev).toEqual({ t: 'text', text: 'Write focused tests' });

    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'task_started' }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'message', message: 'Hello world', append: true }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'task_complete' }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'terminal-call-1',
        name: 'execute',
        input: { command: 'printf hello' },
      }),
    );
    expect(mocks.mockSession.sendAgentMessage.mock.calls).not.toContainEqual([
      'omp',
      expect.objectContaining({ type: 'turn_aborted' }),
    ]);
  });

  it('maps OMP tools onto their ACP-compatible renderers', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-search-tools' });
    await vi.advanceTimersByTimeAsync(1);

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'grep-call-1',
        toolName: 'grep',
        args: { pattern: 'needle', path: 'src' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'glob-call-1',
        toolName: 'glob',
        args: { path: 'src/**/*.ts', hidden: true },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'write-call-1',
        toolName: 'write',
        args: { path: '/tmp/omp-tool-test.txt', content: 'initial content\n' },
      },
    });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'grep-call-1',
        name: 'Grep',
        input: { pattern: 'needle', path: 'src' },
      }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'glob-call-1',
        input: { path: 'src/**/*.ts', pattern: 'src/**/*.ts', hidden: true },
        name: 'Glob',
      }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'write-call-1',
        name: 'Write',
        input: {
          path: '/tmp/omp-tool-test.txt',
          file_path: '/tmp/omp-tool-test.txt',
          content: 'initial content\n',
        },
      }),
    );
  });

  it('renders lowercase OMP tools through compact app contracts', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-compact-tools' });
    await vi.advanceTimersByTimeAsync(1);

    for (const event of [
      { toolCallId: 'yield-call', toolName: 'yield', args: { i: 'Finishing turn' } },
      { toolCallId: 'irc-call', toolName: 'irc', args: { i: 'Messaging agent', op: 'send' } },
      {
        toolCallId: 'task-call',
        toolName: 'task',
        args: {
          i: 'Delegating review',
          tasks: [{ name: 'ReviewWorker', agent: 'reviewer', task: 'Review the change' }],
        },
      },
      { toolCallId: 'browser-call', toolName: 'browser', args: { i: 'Opening app', action: 'open' } },
      { toolCallId: 'todo-call', toolName: 'todo', args: { i: 'Updating work', op: 'done' } },
    ]) {
      mocks.emitBridgeFrame({
        type: 'agent_event',
        event: { type: 'tool_execution_start', ...event },
      });
    }
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'todo-call',
        result: {
          details: {
            phases: [{
              name: 'Repair',
              tasks: [
                { content: 'Fix bridge', status: 'completed' },
                { content: 'Verify phone', status: 'in_progress' },
              ],
            }],
          },
        },
        isError: false,
      },
    });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    for (const expected of [
      { callId: 'yield-call', name: 'yield' },
      { callId: 'irc-call', name: 'irc' },
      { callId: 'browser-call', name: 'fetch' },
    ]) {
      expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
        'omp',
        expect.objectContaining({ type: 'tool-call', ...expected }),
      );
    }
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'task-call',
        name: 'delegate_task',
        input: expect.objectContaining({
          tasks: [expect.objectContaining({
            id: 'ReviewWorker',
            description: 'Review the change',
            role: 'reviewer',
          })],
        }),
      }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({
        type: 'tool-call',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Fix bridge', status: 'completed' },
            { content: 'Verify phone', status: 'in_progress' },
          ],
        },
      }),
    );
    expect(mocks.mockSession.sendAgentMessage).not.toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'tool-call', callId: 'todo-call' }),
    );
  });

  it('preserves output identity across thinking and starts a new segment after tools', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-interleaved' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_start' } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'Before ' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'after' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'advisor-tool-call',
        toolName: 'bash',
        args: { command: 'true' },
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'advisor-tool-call',
        result: { content: [{ type: 'text', text: '' }] },
        isError: false,
      },
    });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: ' after tool' },
      },
    });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;

    const outputMessages = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .filter((message) => message.type === 'message' && message.append === true);
    expect(outputMessages).toHaveLength(3);
    expect(outputMessages.map((message) => message.message)).toEqual(['Before ', 'after', ' after tool']);
    expect(outputMessages[0]?.streamId).toBe(outputMessages[1]?.streamId);
    expect(outputMessages[1]?.streamId).not.toBe(outputMessages[2]?.streamId);
  });

  it('emits one structured advisor message only at message_end', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-advisor' });
    await vi.advanceTimersByTimeAsync(1);
    const advisorMessage = {
      role: 'custom',
      customType: 'advisor',
      display: true,
      details: {
        notes: [
          { note: 'Use a narrower interface', severity: 'concern', advisor: 'reviewer' },
          { note: '', severity: 'nit' },
          { note: 'bad severity', severity: 'invalid' },
        ],
      },
    };
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'message_start', message: advisorMessage } });
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'message_end', message: advisorMessage } });
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: { ...advisorMessage, display: false },
      },
    });
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
    const advisorMessages = mocks.mockSession.sendAgentMessage.mock.calls
      .map((call) => call[1])
      .filter((message) => message.type === 'advisor');
    expect(advisorMessages).toEqual([
      { type: 'advisor', notes: [{ note: 'Use a narrower interface', severity: 'concern', advisor: 'reviewer' }] },
    ]);
  });

  it('starts phone-created sessions under remote control', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials, startedBy: 'daemon' });
    await settleMicrotasks();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-remote' });
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.mockSession.sendSessionEvent).toHaveBeenNthCalledWith(1, { type: 'switch', mode: 'remote' });
    const initialAgentStateUpdater = mocks.mockSession.updateAgentState.mock.calls[0]?.[0];
    expect(initialAgentStateUpdater?.({})).toMatchObject({ controlledByUser: false });
    expect(mocks.mockSpawnPty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ OMP_HAPPY_CONTROL_MODE: 'remote' }),
      }),
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"set_control_mode","mode":"remote"}\n',
    );

    process.stdin.emit('data', 'unexpected startup input');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(child.write).not.toHaveBeenCalled();

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('forwards daemon-session input when attached to a TTY', async () => {
    vi.useFakeTimers();
    const stdin = process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => void };
    const originalIsTTY = stdin.isTTY;
    const originalSetRawMode = stdin.setRawMode;
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(stdin, 'setRawMode', { configurable: true, value: vi.fn() });

    try {
      const runPromise = runOmp({ credentials, startedBy: 'daemon' });
      await settleMicrotasks();
      mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-session-tty' });
      await vi.advanceTimersByTimeAsync(1);

      process.stdin.emit('data', '/advisor off\r');
      expect(child.write).toHaveBeenCalledWith('/advisor off\r');
      expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
        '{"type":"set_control_mode","mode":"remote"}\n',
      );

      child.emitExit(0);
      await vi.advanceTimersByTimeAsync(200);
      await runPromise;
    } finally {
      Object.defineProperty(stdin, 'isTTY', { configurable: true, value: originalIsTTY });
      Object.defineProperty(stdin, 'setRawMode', {
        configurable: true,
        value: originalSetRawMode,
      });
    }
  });

  it('waits for the OMP bridge before forwarding chat and task model roles', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials, startedBy: 'daemon' });
    await settleMicrotasks();
    mocks.mockBridgeSocket.write.mockClear();

    const modelHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'set-model-role',
    )?.[1] as ((request: {
      role: 'default' | 'task';
      model: string;
    }) => Promise<{ success: boolean }>) | undefined;

    const defaultRequest = modelHandler?.({
      role: 'default',
      model: 'openai-codex/gpt-5.6-sol',
    });
    const taskRequest = modelHandler?.({
      role: 'task',
      model: 'anthropic/claude-sonnet-4-6:low',
    });
    await settleMicrotasks();
    expect(mocks.mockBridgeSocket.write).not.toHaveBeenCalled();

    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-model-control' });
    await vi.advanceTimersByTimeAsync(1);

    await expect(defaultRequest).resolves.toEqual({ success: true });
    await expect(taskRequest).resolves.toEqual({ success: true });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"set_model_role","role":"default","spec":"openai-codex/gpt-5.6-sol"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"set_model_role","role":"task","spec":"anthropic/claude-sonnet-4-6:low"}\n',
    );
    expect(mocks.mockBridgeSocket.write).not.toHaveBeenCalledWith(
      '{"type":"set_model","spec":"openai-codex/gpt-5.6-sol"}\n',
    );

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('executes advisor, snapcompact, and goal controls through the session PTY', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials, startedBy: 'daemon' });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-controls' });
    await vi.advanceTimersByTimeAsync(1);
    mocks.mockBridgeSocket.write.mockClear();

    const advisorHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'set-advisor',
    )?.[1] as ((request: { enabled: boolean }) => Promise<{ success: boolean }>) | undefined;
    const compactHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'compact-snapcompact',
    )?.[1] as (() => Promise<{ success: boolean }>) | undefined;
    const goalHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls.find(
      ([name]) => name === 'goal-command',
    )?.[1] as ((request: { action: string; objective?: string }) => Promise<{ success: boolean }>) | undefined;

    await expect(advisorHandler?.({ enabled: false })).resolves.toEqual({ success: true });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith('{"type":"set_advisor","enabled":false}\n');
    mocks.emitBridgeFrame({ type: 'tui_command_ready', command: '/advisor off' });
    expect(child.write).toHaveBeenCalledWith('\r');
    mocks.emitBridgeFrame({ type: 'input', text: '/advisor off', source: 'interactive' });
    const advisorMetadataUpdater = mocks.mockSession.updateMetadata.mock.calls.at(-1)?.[0] as MetadataUpdater;
    expect(advisorMetadataUpdater({ path: '/repo' })).toEqual({ path: '/repo', advisorEnabled: false });

    await expect(compactHandler?.()).resolves.toEqual({ success: true });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith('{"type":"compact_snapcompact"}\n');
    mocks.emitBridgeFrame({ type: 'tui_command_ready', command: '/compact snapcompact' });
    expect(child.write).toHaveBeenCalledTimes(2);

    await expect(goalHandler?.({ action: 'set', objective: '  Ship\nsafely  ' })).resolves.toEqual({ success: true });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      '{"type":"goal_command","action":"set","objective":"  Ship\\nsafely  "}\n',
    );
    mocks.emitBridgeFrame({ type: 'tui_command_ready', command: '/goal set Ship safely' });
    expect(child.write).toHaveBeenCalledTimes(3);

    for (const action of ['show', 'pause', 'resume', 'drop']) {
      await expect(goalHandler?.({ action })).resolves.toEqual({ success: true });
      expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
        `{"type":"goal_command","action":"${action}"}\n`,
      );
      mocks.emitBridgeFrame({ type: 'tui_command_ready', command: `/goal ${action}` });
    }
    expect(child.write).toHaveBeenCalledTimes(7);

    const writesBeforeInvalidRequests = mocks.mockBridgeSocket.write.mock.calls.length;
    await expect(goalHandler?.({ action: 'invalid' })).resolves.toEqual({ success: false });
    await expect(goalHandler?.({ action: 'set' })).resolves.toEqual({ success: false });
    await expect(goalHandler?.({ action: 'set', objective: ' \n\t ' })).resolves.toEqual({ success: false });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledTimes(writesBeforeInvalidRequests);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('forwards sudo prompts that reach the PTY before the bash lifecycle event', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials, startedBy: 'daemon' });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-sudo' });
    await vi.advanceTimersByTimeAsync(1);

    child.emitData('\u001b[2K│ [sudo] password for zarathustra: \u001b[0m│\r\n│ esc force-kill · input forwarded to PTY │');
    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'sudo-call',
        toolName: 'bash',
        args: { command: 'sudo true' },
      },
    });
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith('omp', expect.objectContaining({
      type: 'permission-request',
      parentToolCallId: 'sudo-call',
    }));
    child.emitData('\r\n│ still repainting the active PTY overlay │');
    await vi.advanceTimersByTimeAsync(150);

    const promptCall = mocks.mockSession.sendAgentMessage.mock.calls.find(([, message]) =>
      isRecord(message) && message.type === 'permission-request' && message.description === '[sudo] password for zarathustra:'
    );
    expect(promptCall).toBeDefined();
    const promptMessage = promptCall?.[1];
    if (!isRecord(promptMessage) || typeof promptMessage.permissionId !== 'string') {
      throw new Error('Expected an inline PTY password prompt');
    }
    expect(promptMessage.options).toMatchObject({
      inputKind: 'password',
      questions: [{ id: 'password', secret: true }],
    });
    expect(promptMessage.parentToolCallId).toBe('sudo-call');

    const permissionHandler = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls
      .find((call) => call[0] === 'permission')?.[1];
    await permissionHandler?.({
      id: promptMessage.permissionId,
      approved: true,
      updatedInput: { answers: { password: 'not-a-real-password' } },
    });
    expect(child.write).toHaveBeenCalledWith('not-a-real-password\r');
    expect(mocks.mockBridgeSocket.write).not.toHaveBeenCalledWith(
      expect.stringContaining('"type":"ask_response"'),
    );

    mocks.emitBridgeFrame({
      type: 'agent_event',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'sudo-call',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      },
    });
    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('routes remote OMP ask requests and answers through the permission RPC', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials, startedBy: 'daemon' });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-ask' });
    await vi.advanceTimersByTimeAsync(1);

    mocks.emitBridgeFrame({
      type: 'ask_request',
      id: 'ask-1',
      questions: [{
        id: 'phone',
        question: 'Which phone?',
        options: [{ label: 'Pixel' }, { label: 'Samsung', description: 'WiFi target' }],
        multi: false,
      }],
    });

    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith('omp', {
      type: 'permission-request',
      permissionId: 'ask-1',
      toolName: 'AskUserQuestion',
      description: 'Which phone?',
      options: {
        questions: [{
          id: 'phone',
          question: 'Which phone?',
          header: 'phone',
          options: [{ label: 'Pixel' }, { label: 'Samsung', description: 'WiFi target' }],
          multi: false,
          multiSelect: false,
        }],
      },
    });

    const permissionRegistration = mocks.mockSession.rpcHandlerManager.registerHandler.mock.calls
      .find((call) => call[0] === 'permission');
    expect(permissionRegistration).toBeDefined();
    await permissionRegistration?.[1]({
      id: 'ask-1',
      approved: true,
      updatedInput: { answers: { phone: 'Samsung' } },
    });
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'ask_response', id: 'ask-1', answers: { phone: 'Samsung' } })}\n`,
    );

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });
});
