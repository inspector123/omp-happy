import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Plain ESM is loaded directly by OMP.
import {
  CROSS_PROCESS_IRC_PROTOCOL,
  CrossProcessBroker,
  CrossProcessClient,
  CrossProcessIrcRuntime,
  FrameDecoder,
  MAX_FRAME_BYTES,
  authenticationProof,
  deriveCrossProcessScope,
  encodeFrame,
  installCrossProcessIrc,
  parseQualifiedIdentity,
  readOrCreateToken,
  resetCrossProcessIrcForTests,
} from './omp-cross-process-irc.mjs';

type DeliveryFrame = {
  fromInstance: string;
  fromNamespace: string;
  fromAgent: string;
  toAgent: string;
  messageId: string;
  body: string;
  replyTo?: string;
  expectsReply?: boolean;
};

type BrokerFactoryOptions = {
  scope: { id: string; uid: number; runtimeDir: string; socketPath: string; tokenPath: string };
  token: string;
};
type DeliveryReceipt = { outcome: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetCrossProcessIrcForTests();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

async function tempScope(profile = 'test') {
  const root = await mkdtemp(join(tmpdir(), 'omp-cross-irc-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = await deriveCrossProcessScope({ cwd: root, runtimeRoot: root, uid: process.getuid?.() ?? 0, profile });
  const token = await readOrCreateToken(scope);
  return { root, scope, token };
}

async function tick() {
  const gate = Promise.withResolvers<void>();
  setImmediate(gate.resolve);
  await gate.promise;
}

async function eventually(assertion: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
    }
    await tick();
  }
  throw error;
}

const MAIN_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const mainAgent = (sessionId = MAIN_SESSION_ID, controlEnabled = false) => [
  { id: 'Main', displayName: 'Main', kind: 'main', status: 'idle', sessionId, controlEnabled },
];

function fakeZod() {
  const schema = { optional: () => schema, min: () => schema };
  return {
    object: () => schema,
    enum: () => schema,
    string: () => schema,
    boolean: () => schema,
    number: () => schema,
    array: () => schema,
    record: () => schema,
  };
}

describe('cross-process IRC opt-in and scope', () => {
  it('is a disabled no-op', () => {
    const api = { registerTool: vi.fn(), on: vi.fn(), zod: fakeZod() };
    expect(installCrossProcessIrc(api, { enabled: false })).toBeUndefined();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });

  it('isolates project, profile, and uid scopes', async () => {
    const { root } = await tempScope();
    const a = await deriveCrossProcessScope({ cwd: root, runtimeRoot: root, profile: 'a', uid: 1000 });
    const b = await deriveCrossProcessScope({ cwd: root, runtimeRoot: root, profile: 'b', uid: 1000 });
    const c = await deriveCrossProcessScope({ cwd: root, runtimeRoot: root, profile: 'a', uid: 1001 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(a.socketPath).not.toContain('scope-a');
  });

  it('creates private runtime and token files', async () => {
    const { scope, token } = await tempScope();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(scope.runtimeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(scope.tokenPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(scope.tokenPath, 'utf8')).toBe(token);
  });
});

describe('framing and authentication', () => {
  it('parses partial frames and rejects malformed or oversized frames', () => {
    const decoder = new FrameDecoder();
    const encoded = encodeFrame({ v: CROSS_PROCESS_IRC_PROTOCOL, type: 'heartbeat' });
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
    expect(decoder.push(encoded.subarray(3))).toEqual([{ v: CROSS_PROCESS_IRC_PROTOCOL, type: 'heartbeat' }]);
    expect(() => encodeFrame({ v: CROSS_PROCESS_IRC_PROTOCOL, type: 'x', body: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/exceeds limit/);
    const invalid = Buffer.alloc(4);
    invalid.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(invalid)).toThrow(/frame length/);
  });

  it('binds proof to token, scope, instance, and nonce', () => {
    const proof = authenticationProof('a'.repeat(64), 'scope-a', 'instance-a', 'nonce-a');
    expect(proof).toHaveLength(64);
    expect(authenticationProof('a'.repeat(64), 'scope-b', 'instance-a', 'nonce-a')).not.toBe(proof);
    expect(authenticationProof('b'.repeat(64), 'scope-a', 'instance-a', 'nonce-a')).not.toBe(proof);
  });

  it('closes clients with an invalid proof', async () => {
    const { scope, token } = await tempScope();
    const broker = new CrossProcessBroker({ scope, token });
    await broker.listen();
    cleanups.push(() => broker.close());
    const socket = createConnection(scope.socketPath);
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    socket.once('connect', connected.resolve);
    socket.once('error', connected.reject);
    socket.once('close', closed.resolve);
    await connected.promise;
    socket.write(encodeFrame({
      v: CROSS_PROCESS_IRC_PROTOCOL,
      type: 'hello',
      scope: scope.id,
      instanceId: 'bad-client',
      alias: 'bad',
      nonce: 'nonce',
      proof: '0'.repeat(64),
      agents: [],
      agentGeneration: 1,
    }));
    await closed.promise;
    expect(socket.destroyed).toBe(true);
  });
});

describe('qualified identities and delegation', () => {
  it('preserves qualified Main identities', () => {
    expect(parseQualifiedIdentity('other/Main')).toEqual({ namespace: 'other', agentId: 'Main' });
    expect(parseQualifiedIdentity('Main')).toBeUndefined();
    expect(parseQualifiedIdentity('../Main')).toBeUndefined();
  });

  it('delegates all non-remote and lifecycle/process operations exactly once', async () => {
    const invokeTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'native' }], details: {} }));
    const runtime = new CrossProcessIrcRuntime({ api: {}, internals: async () => ({}) });
    for (const op of ['jobs', 'cancel', 'start', 'ps', 'logs', 'stop', 'restart', 'describe']) {
      invokeTool.mockClear();
      const result = await runtime.execute({ op }, { invokeTool }, undefined);
      expect(result.content[0].text).toBe('native');
      expect(invokeTool).toHaveBeenCalledTimes(1);
    }
  });
});

describe('same-host list, send, reply, dedupe, and reconnect', () => {
  it('discovers peers, routes replies, and deduplicates a repeated message id', async () => {
    const { scope, token } = await tempScope();
    const delivered: DeliveryFrame[] = [];
    const capture = (outcome: string) => async (frame: DeliveryFrame) => {
      delivered.push(frame);
      return { outcome };
    };
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agents: mainAgent, deliver: capture('woken'),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      agents: mainAgent, deliver: capture('injected'),
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => {
      expect(a.list().map((peer: { qualifiedId: string }) => peer.qualifiedId)).toContain('beta/Main');
      expect(b.list().map((peer: { qualifiedId: string }) => peer.qualifiedId)).toContain('alpha/Main');
    });

    const messageId = 'message-id-1';
    await expect(a.send({ fromAgent: 'Main', to: 'beta/Main', body: 'hello', messageId })).resolves.toMatchObject({ outcome: 'injected', messageId });
    await expect(a.send({ fromAgent: 'Main', to: 'beta/Main', body: 'hello', messageId })).resolves.toMatchObject({ outcome: 'injected', messageId });
    expect(delivered.filter((frame) => frame.messageId === messageId)).toHaveLength(1);
    await expect(b.send({ fromAgent: 'Main', to: 'alpha/Main', body: 'reply', replyTo: messageId })).resolves.toMatchObject({ outcome: 'woken' });
    expect(delivered.some((frame) => frame.replyTo === messageId)).toBe(true);
  });

  it('serializes deliveries in broker order', async () => {
    const { scope, token } = await tempScope();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agents: mainAgent, deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      agents: mainAgent,
      deliver: async (frame: DeliveryFrame) => {
        order.push(`start:${frame.body}`);
        if (frame.body === 'first') await gate.promise;
        order.push(`end:${frame.body}`);
        return { outcome: 'injected' };
      },
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.resolveTarget('beta/Main')).toBeDefined());

    const first = a.send({ fromAgent: 'Main', to: 'beta/Main', body: 'first' });
    const second = a.send({ fromAgent: 'Main', to: 'beta/Main', body: 'second' });
    await eventually(() => expect(order).toEqual(['start:first']));
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('retains broker ownership across a transient client reconnect', async () => {
    const { scope, token } = await tempScope();
    const brokers: CrossProcessBroker[] = [];
    const brokerFactory = (options: BrokerFactoryOptions) => {
      const broker = new CrossProcessBroker(options);
      brokers.push(broker);
      return broker;
    };
    const deliver = async () => ({ outcome: 'injected' });
    const reconnected = Promise.withResolvers<void>();
    let watchReconnect = false;
    let a: CrossProcessClient;
    const onRosterChange = () => {
      if (watchReconnect && a.connected) reconnected.resolve();
    };
    a = new CrossProcessClient({
      scope, token, alias: 'alpha', instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      agents: mainAgent, deliver, brokerFactory, onRosterChange,
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      agents: mainAgent, deliver, brokerFactory,
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
      async () => { await Promise.all(brokers.map((broker) => broker.close())); },
    );
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));
    const owner = brokers.find((broker) => broker.endpointIdentity);
    expect(owner).toBeDefined();
    const ownerClose = owner ? vi.spyOn(owner, 'close') : undefined;

    watchReconnect = true;
    a.socket.destroy();
    await reconnected.promise;
    expect(a.connected).toBe(true);
    await a.close();
    expect(ownerClose).toHaveBeenCalled();
  });

  it('withdraws a disconnected peer and accepts a full reconnect roster', async () => {
    const { scope, token } = await tempScope();
    const deliver = async () => ({ outcome: 'injected' });
    const a = new CrossProcessClient({ scope, token, alias: 'alpha', instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agents: mainAgent, deliver });
    const b = new CrossProcessClient({ scope, token, alias: 'beta', instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', agents: mainAgent, deliver });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));
    await b.close();
    await eventually(() => expect(a.list()).toHaveLength(0));
    const replacement = new CrossProcessClient({ scope, token, alias: 'beta', instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', agents: mainAgent, deliver });
    cleanups.push(() => replacement.close());
    await replacement.start();
    await eventually(() => expect(a.list()[0]).toMatchObject({ qualifiedId: 'beta/Main' }));
  });
});

describe('UUID-routed remote configuration', () => {
  const ALPHA_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
  const BETA_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222';

  it('routes by exact session UUID and returns the recipient-observed model and effort', async () => {
    const { scope, token } = await tempScope();
    const configure = vi.fn(async () => ({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'high',
    }));
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', agents: () => mainAgent(ALPHA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', agents: () => mainAgent(BETA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }), configure,
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toMatchObject([{ sessionId: BETA_SESSION, controlEnabled: true }]));

    await expect(a.configure({
      sessionId: BETA_SESSION, model: 'openai-codex/gpt-5.6-sol', effort: 'high',
    })).resolves.toMatchObject({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'high',
      operationId: expect.any(String),
    });
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown result when the target disconnects before acknowledging control', async () => {
    const { scope, token } = await tempScope();
    const started = Promise.withResolvers<void>();
    const apply = Promise.withResolvers<{ outcome: string; model: string; effort: string }>();
    const configure = vi.fn(async () => {
      started.resolve();
      return apply.promise;
    });
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', agents: () => mainAgent(ALPHA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', agents: () => mainAgent(BETA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }), configure,
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));

    const pending = a.configure({ sessionId: BETA_SESSION, effort: 'medium', timeoutMs: 5_000 });
    await started.promise;
    await b.close();
    await expect(pending).resolves.toMatchObject({
      outcome: 'delivery_unknown', code: 'target_disconnected',
    });
    apply.resolve({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'medium',
    });
  });

  it('deduplicates an in-flight operation and rejects conflicting reuse', async () => {
    const { scope, token } = await tempScope();
    const started = Promise.withResolvers<void>();
    const apply = Promise.withResolvers<{ outcome: string; model: string; effort: string }>();
    const configure = vi.fn(async () => {
      started.resolve();
      return apply.promise;
    });
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', agents: () => mainAgent(ALPHA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', agents: () => mainAgent(BETA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }), configure,
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));

    const operationId = 'ffffffff-6666-4666-8666-666666666666';
    const first = a.configure({ sessionId: BETA_SESSION, effort: 'medium', operationId });
    await started.promise;
    const duplicate = a.configure({ sessionId: BETA_SESSION, effort: 'medium', operationId });
    const conflict = a.configure({ sessionId: BETA_SESSION, effort: 'high', operationId });
    apply.resolve({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'medium',
    });

    await expect(first).resolves.toMatchObject({ outcome: 'configured', operationId });
    await expect(duplicate).resolves.toMatchObject({ outcome: 'configured', operationId });
    await expect(conflict).resolves.toMatchObject({
      outcome: 'failed', code: 'operation_conflict', operationId,
    });
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('fails closed for disabled control and an unknown UUID', async () => {
    const { scope, token } = await tempScope();
    const configure = vi.fn();
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', agents: () => mainAgent(ALPHA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', agents: () => mainAgent(BETA_SESSION, false),
      deliver: async () => ({ outcome: 'injected' }), configure,
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));

    await expect(a.configure({ sessionId: BETA_SESSION, effort: 'high' }))
      .resolves.toMatchObject({ outcome: 'failed', code: 'control_disabled' });
    await expect(a.configure({ sessionId: 'cccccccc-3333-4333-8333-333333333333', effort: 'high' }))
      .resolves.toMatchObject({ outcome: 'failed', code: 'target_unavailable' });
    expect(configure).not.toHaveBeenCalled();
  });

  it('times out without replay and deduplicates a repeated operation id', async () => {
    const { scope, token } = await tempScope();
    const stalled = Promise.withResolvers<void>().promise;
    const configure = vi.fn()
      .mockImplementationOnce(async () => stalled)
      .mockResolvedValue({ outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'medium' });
    const a = new CrossProcessClient({
      scope, token, alias: 'alpha', agents: () => mainAgent(ALPHA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }),
    });
    const b = new CrossProcessClient({
      scope, token, alias: 'beta', agents: () => mainAgent(BETA_SESSION, true),
      deliver: async () => ({ outcome: 'injected' }), configure,
    });
    cleanups.push(() => a.close(), () => b.close());
    await a.start();
    await b.start();
    await eventually(() => expect(a.list()).toHaveLength(1));

    await expect(a.configure({ sessionId: BETA_SESSION, effort: 'medium', timeoutMs: 1 }))
      .resolves.toMatchObject({ outcome: 'delivery_unknown', code: 'timeout' });
    const operationId = 'dddddddd-4444-4444-8444-444444444444';
    await expect(a.configure({ sessionId: BETA_SESSION, effort: 'medium', operationId }))
      .resolves.toMatchObject({ outcome: 'configured', operationId });
    await expect(a.configure({ sessionId: BETA_SESSION, effort: 'medium', operationId }))
      .resolves.toMatchObject({ outcome: 'configured', operationId });
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('validates models, configured efforts, and the current main session before applying control', async () => {
    const { root } = await tempScope();
    let currentModel = {
      provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true,
      thinking: { efforts: ['low', 'medium', 'high'] },
    };
    let configuredEffort = 'medium';
    let effectiveEffort = 'medium';
    const manager = { getSessionId: () => BETA_SESSION };
    let activeSession = {
      sessionManager: manager,
      configuredThinkingLevel: () => configuredEffort,
    };
    const registry = {
      list: () => [{ id: 'Main', kind: 'main', status: 'idle', session: activeSession }],
      onChange: () => () => {},
    };
    const setModel = vi.fn(async (model) => { currentModel = model; return true; });
    const setThinkingLevel = vi.fn((level) => {
      configuredEffort = level;
      if (level !== 'auto') effectiveEffort = level;
    });
    let configureDelivery;
    const runtime = new CrossProcessIrcRuntime({
      api: {
        setModel, setThinkingLevel, getThinkingLevel: () => effectiveEffort,
        pi: {},
      },
      controlEnabled: true,
      scopeOptions: { runtimeRoot: root, profile: 'control-test', uid: process.getuid?.() ?? 0 },
      internals: async () => ({
        AgentRegistry: { global: () => registry },
      }),
      clientFactory: (options) => {
        configureDelivery = options.configure;
        return { start: async () => {}, publishRoster: () => {}, close: async () => {}, list: () => [] };
      },
    });
    const targetModel = {
      provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true,
      thinking: { efforts: ['low', 'medium', 'high'] },
    };
    await runtime.bind({
      cwd: root,
      sessionManager: manager,
      models: {
        current: () => currentModel,
        resolve: (spec) => spec === 'openai-codex/gpt-5.6-sol' ? targetModel : undefined,
      },
    });

    await expect(configureDelivery({
      sessionId: BETA_SESSION, model: 'unknown/model', operationId: 'unsupported-model',
    })).resolves.toMatchObject({ outcome: 'failed', code: 'unsupported_model' });
    await expect(configureDelivery({
      sessionId: BETA_SESSION, effort: 'ultra', operationId: 'unsupported-effort',
    })).resolves.toMatchObject({ outcome: 'failed', code: 'unsupported_effort' });
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();

    await expect(configureDelivery({
      sessionId: BETA_SESSION, model: 'openai-codex/gpt-5.6-sol', effort: 'high', operationId: 'success',
    })).resolves.toMatchObject({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'high',
    });
    expect(setModel).toHaveBeenCalledWith(targetModel);
    expect(setThinkingLevel).toHaveBeenCalledWith('high');

    await expect(configureDelivery({
      sessionId: BETA_SESSION, effort: 'auto', operationId: 'auto',
    })).resolves.toMatchObject({
      outcome: 'configured', model: 'openai-codex/gpt-5.6-sol', effort: 'auto',
    });
    expect(effectiveEffort).toBe('high');

    const nextManager = { getSessionId: () => 'eeeeeeee-5555-4555-8555-555555555555' };
    activeSession = {
      sessionManager: nextManager,
      configuredThinkingLevel: () => configuredEffort,
    };
    await runtime.bind({
      cwd: root,
      sessionManager: nextManager,
      models: {
        current: () => currentModel,
        resolve: () => targetModel,
      },
    });
    const setterCalls = setThinkingLevel.mock.calls.length;
    await expect(configureDelivery({
      sessionId: BETA_SESSION, effort: 'low', operationId: 'stale-session',
    })).resolves.toMatchObject({ outcome: 'failed', code: 'target_unavailable' });
    expect(setThinkingLevel).toHaveBeenCalledTimes(setterCalls);
  });
});

describe('remote wait and inbox semantics', () => {
  it('binds exact session identity, consumes waits first, and buffers failed delivery', async () => {
    const { root } = await tempScope();
    const manager = { getSessionId: () => MAIN_SESSION_ID };
    const localDeliver = vi.fn(async () => { throw new Error('recipient unavailable'); });
    const ref = {
      id: 'Main', displayName: 'Main', kind: 'main', status: 'idle',
      session: { sessionManager: manager, deliverIrcMessage: localDeliver },
    };
    const registry = { get: () => ref, list: () => [ref], onChange: () => () => {} };
    let receive: (frame: DeliveryFrame) => Promise<DeliveryReceipt> = async () => ({ outcome: 'failed' });
    const fakeClient = {
      start: vi.fn(async () => {}),
      publishRoster: vi.fn(),
      list: () => [],
      resolveTarget: (value: string) => value === 'remote/Main' ? { peer: { instanceId: 'remote-instance' }, agentId: 'Main' } : undefined,
      send: vi.fn(async (_options: { messageId: string }) => ({ outcome: 'failed' })),
    };
    const runtime = new CrossProcessIrcRuntime({
      api: { pi: { AgentRegistry: { global: () => registry } } },
      scopeOptions: { runtimeRoot: root, profile: 'runtime-test', uid: process.getuid?.() ?? 0 },
      clientFactory: (options: { deliver: (frame: DeliveryFrame) => Promise<DeliveryReceipt> }) => {
        receive = options.deliver;
        return fakeClient;
      },
    });
    await runtime.bind({ cwd: root, sessionManager: manager });
    expect(runtime.localAgentId(manager)).toBe('Main');
    expect(runtime.localAgentId({})).toBeUndefined();

    fakeClient.send.mockImplementationOnce(async (options: { messageId: string }) => {
      await receive({
        fromInstance: 'remote-instance', fromNamespace: 'remote', fromAgent: 'Main', toAgent: 'Main',
        messageId: 'uncorrelated-reply', body: 'answer from the awaited peer',
      });
      return { outcome: 'injected', messageId: options.messageId };
    });
    const awaitedSend = await runtime.execute(
      { op: 'send', to: 'remote/Main', message: 'question', await: true },
      { sessionManager: manager, invokeTool: vi.fn() },
      undefined,
    );
    expect(awaitedSend.details.waited).toMatchObject({
      id: 'uncorrelated-reply',
      body: 'answer from the awaited peer',
    });
    expect(awaitedSend.details.waited).not.toHaveProperty('replyTo');
    expect(JSON.stringify(runtime.agents())).not.toMatch(/session(File|Manager)|[/\\]tmp[/\\]/);

    const wait = runtime.execute(
      { op: 'wait', from: 'remote/Main', timeoutMs: 0 },
      { sessionManager: manager, invokeTool: vi.fn() },
      undefined,
    );
    await tick();
    await expect(receive({
      fromInstance: 'remote-instance', fromNamespace: 'remote', fromAgent: 'Main', toAgent: 'Main',
      messageId: 'waited-message', body: 'answer',
    })).resolves.toEqual({ outcome: 'injected' });
    await expect(wait).resolves.toMatchObject({ details: { op: 'wait', waited: { body: 'answer' } } });
    expect(localDeliver).not.toHaveBeenCalled();

    await receive({
      fromInstance: 'remote-instance', fromNamespace: 'remote', fromAgent: 'Main', toAgent: 'Main',
      messageId: 'failed-message', body: 'buffer me',
    });
    expect(localDeliver).toHaveBeenCalledTimes(1);
    const invokeTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'native inbox' }], details: { op: 'inbox' } }));
    const inbox = await runtime.execute({ op: 'inbox' }, { sessionManager: manager, invokeTool }, undefined);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(inbox.details.remoteInbox).toMatchObject([{ id: 'failed-message', body: 'buffer me' }]);
  });
});
