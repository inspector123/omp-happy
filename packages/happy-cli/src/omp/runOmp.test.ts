import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

type UserMessageHandler = (message: unknown) => Promise<void> | void;
type FileEventHandler = (message: unknown) => void;
type MetadataRecord = Record<string, unknown>;
type MetadataUpdater = (state: MetadataRecord) => MetadataRecord;
type AgentStateUpdater = (state: MetadataRecord) => MetadataRecord;
type PtyDataHandler = (data: string) => void;
type PtyExitHandler = (event: { exitCode: number; signal?: number }) => void;

const mocks = vi.hoisted(() => {
  let userMessageHandler: UserMessageHandler | null = null;
  let fileEventHandler: FileEventHandler | null = null;

  const mockSession = {
    onUserMessage: vi.fn((handler: UserMessageHandler) => {
      userMessageHandler = handler;
    }),
    onFileEvent: vi.fn((handler: FileEventHandler) => {
      fileEventHandler = handler;
    }),
    drainAttachmentsForUserMessage: vi.fn(async () => []),
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
    rpcHandlerManager: {},
  };

  return {
    mockSpawnPty: vi.fn(),
    mockMkdtemp: vi.fn(),
    mockRm: vi.fn(),
    mockStat: vi.fn(),
    mockOpen: vi.fn(),
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
    resetHandlers: () => {
      userMessageHandler = null;
      fileEventHandler = null;
    },
  };
});

vi.mock('node-pty', () => ({
  spawn: mocks.mockSpawnPty,
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mockMkdtemp,
  open: mocks.mockOpen,
  rm: mocks.mockRm,
  stat: mocks.mockStat,
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

let mirrorContent = '';
let child: FakePty;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function appendMirrorFrame(frame: unknown): void {
  mirrorContent += `${JSON.stringify(frame)}\n`;
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

    mirrorContent = '';
    child = new FakePty();
    mocks.resetHandlers();

    mocks.mockMkdtemp.mockResolvedValue('/tmp/happy-omp-test');
    mocks.mockRm.mockResolvedValue(undefined);
    mocks.mockStat.mockImplementation(async () => ({
      size: Buffer.byteLength(mirrorContent, 'utf8'),
    }));
    mocks.mockOpen.mockImplementation(async () => ({
      read: async (buffer: Buffer, offset: number, length: number, position: number | bigint | null) => {
        const start = typeof position === 'bigint' ? Number(position) : (position ?? 0);
        const chunk = Buffer.from(mirrorContent, 'utf8').subarray(start, start + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length, buffer };
      },
      close: async () => {},
    }));
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

  it('launches literal omp through node-pty with allow-home and the mirror env', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({
      credentials,
      extraArgs: ['--model', 'test-model'],
    });

    await settleMicrotasks();

    expect(mocks.mockSpawnPty).toHaveBeenCalledWith(
      'omp',
      ['--allow-home', '--model', 'test-model'],
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          OMP_HAPPY_MIRROR_PATH: '/tmp/happy-omp-test/mirror.jsonl',
        }),
        name: expect.any(String),
        cols: expect.any(Number),
        rows: expect.any(Number),
      }),
    );
    expect(child.onData).toHaveBeenCalledTimes(1);
    expect(child.onExit).toHaveBeenCalledTimes(1);

    appendMirrorFrame({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('switches to remote mode and writes a phone prompt into the pty child', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    appendMirrorFrame({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);

    const userMessageHandler = mocks.getUserMessageHandler();
    expect(userMessageHandler).toBeTypeOf('function');
    await userMessageHandler?.({
      content: { text: 'Prompt from phone' },
    });

    expect(mocks.mockSession.sendSessionEvent).toHaveBeenNthCalledWith(1, { type: 'switch', mode: 'local' });
    expect(mocks.mockSession.sendSessionEvent).toHaveBeenNthCalledWith(2, { type: 'switch', mode: 'remote' });
    expect(child.write.mock.calls).toEqual([['Prompt from phone'], ['\r']]);

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('does not re-send a mirrored remote prompt as a duplicate local user envelope', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    appendMirrorFrame({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);

    const userMessageHandler = mocks.getUserMessageHandler();
    expect(userMessageHandler).toBeTypeOf('function');
    await userMessageHandler?.({
      content: { text: 'Prompt from phone' },
    });

    appendMirrorFrame({
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Prompt from phone' }],
        },
      },
    });
    appendMirrorFrame({
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'A later mirrored local prompt' }],
        },
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.mockSession.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    const forwardedEnvelope = mocks.mockSession.sendSessionProtocolMessage.mock.calls[0]?.[0];
    expect(isRecord(forwardedEnvelope)).toBe(true);
    if (!isRecord(forwardedEnvelope)) {
      throw new Error('Expected only the non-echo prompt to be forwarded');
    }
    expect(forwardedEnvelope.role).toBe('user');
    expect(forwardedEnvelope.ev).toEqual({ t: 'text', text: 'A later mirrored local prompt' });

    child.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    await runPromise;
  });

  it('mirrors terminal prompts and assistant output into the session stream', async () => {
    vi.useFakeTimers();

    const runPromise = runOmp({ credentials });
    await settleMicrotasks();

    appendMirrorFrame({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);

    appendMirrorFrame({
      type: 'agent_event',
      event: { type: 'agent_start' },
    });
    appendMirrorFrame({
      type: 'agent_event',
      event: {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Write focused tests' }],
        },
      },
    });
    appendMirrorFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
      },
    });
    appendMirrorFrame({
      type: 'agent_event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', delta: 'world' },
      },
    });
    appendMirrorFrame({
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
      throw new Error('Expected a user session envelope from mirrored input');
    }
    expect(firstEnvelope.role).toBe('user');
    expect(firstEnvelope.ev).toEqual({ t: 'text', text: 'Write focused tests' });

    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'task_started' }),
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      { type: 'message', message: 'Hello world' },
    );
    expect(mocks.mockSession.sendAgentMessage).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining({ type: 'task_complete' }),
    );
    expect(mocks.mockSession.sendAgentMessage.mock.calls).not.toContainEqual([
      'omp',
      expect.objectContaining({ type: 'turn_aborted' }),
    ]);
  });
});
