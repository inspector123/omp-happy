import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const bridgeDataHandlers = new Map<object, BridgeDataHandler>();

  const createBridgeSocket = () => {
    const socket = {
      writable: true,
      setEncoding: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: BridgeEventHandler) => {
        if (event === 'data') bridgeDataHandlers.set(socket, handler as BridgeDataHandler);
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
    mockRegisterKillSessionHandler: vi.fn(),
    mockSetBackend: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockCancel: vi.fn(),
    mockSession,
    getUserMessageHandler: () => userMessageHandler,
    getFileEventHandler: () => fileEventHandler,
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
    resetHandlers: () => {
      userMessageHandler = null;
      fileEventHandler = null;
      bridgeConnectionHandler = null;
      bridgeDataHandlers.clear();
      listeningHandler = null;
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
  });

  it('launches native omp through node-pty with the bundled extension bridge', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({
      credentials,
      extraArgs: ['--model', 'test-model'],
    });

    await settleMicrotasks();

    expect(mocks.mockSpawnPty).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^omp$|\/\.local\/bin\/omp$)/),
      ['--allow-home', '--extension', expect.stringMatching(/scripts\/omp-happy-bridge\.mjs$/), '--model', 'test-model'],
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          OMP_HAPPY_BRIDGE_SOCKET: '/tmp/happy-omp-test/bridge.sock',
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
      thoughtLevels: [
        { code: 'off', value: 'Off' },
        { code: 'high', value: 'High' },
      ],
      currentThoughtLevel: 'high',
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
      thoughtLevels: [
        { code: 'off', value: 'Off' },
        { code: 'high', value: 'High' },
      ],
      currentThoughtLevelCode: 'high',
    });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('switches to remote mode and sends a phone prompt through the extension bridge', async () => {
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

    expect(mocks.mockSession.sendSessionEvent).toHaveBeenNthCalledWith(1, { type: 'switch', mode: 'local' });
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenNthCalledWith(2, { type: 'switch', mode: 'remote' });
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

  it('queues a phone prompt received while stop is completing', async () => {
    vi.useFakeTimers();
    const runPromise = runOmp({ credentials });
    await settleMicrotasks();
    mocks.emitBridgeFrame({ type: 'ready', protocolVersion: 1, sessionId: 'omp-abort-queue' });
    await vi.advanceTimersByTimeAsync(1);
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
    expect(mocks.mockBridgeSocket.write).toHaveBeenCalledTimes(1);
    mocks.emitBridgeFrame({ type: 'agent_event', event: { type: 'agent_end' } });
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      2,
      '{"type":"set_model","spec":"openai/gpt-5.6-sol"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      3,
      '{"type":"set_thinking_level","level":"high"}\n',
    );
    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      4,
      '{"type":"prompt","text":"Run after stop","images":[]}\n',
    );

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

    const userMessageHandler = mocks.getUserMessageHandler();
    await userMessageHandler?.({
      content: { text: '' },
      meta: { model: 'openai/gpt-5.6-sol', effort: 'high' },
    });

    expect(mocks.mockBridgeSocket.write).toHaveBeenNthCalledWith(
      1,
      '{"type":"set_model","spec":"openai/gpt-5.6-sol"}\n',
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

    process.stdin.emit('data', 'unexpected startup input');
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(child.write).not.toHaveBeenCalled();

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });
});
