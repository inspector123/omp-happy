import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, chmod, lstat, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CROSS_PROCESS_IRC_ENV = 'OMP_CROSS_PROCESS_IRC';
export const CROSS_PROCESS_IRC_REMOTE_CONTROL_ENV = 'OMP_CROSS_PROCESS_IRC_REMOTE_CONTROL';
export const CROSS_PROCESS_IRC_ALIAS_ENV = 'OMP_CROSS_PROCESS_IRC_ALIAS';
export const CROSS_PROCESS_IRC_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const HEARTBEAT_MS = 2_000;
export const LEASE_MS = 7_000;
export const DELIVERY_TIMEOUT_MS = 15_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_CAP = 2_000;
export const MAX_PEERS = 16;
export const MAX_AGENTS_PER_PEER = 64;
const TOKEN_BYTES = 32;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
const QUALIFIED_RE = /^([^/]+)\/(.+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIMES_KEY = Symbol.for('omp-happy.cross-process-irc.runtimes');
const runtimes = globalThis[RUNTIMES_KEY] ??= new Map();

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

function constantTimeTextEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function boundedText(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

export function sanitizeAlias(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return ALIAS_RE.test(text) ? text : fallback;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function parseQualifiedIdentity(value) {
  if (typeof value !== 'string') return undefined;
  const match = QUALIFIED_RE.exec(value);
  if (!match || !ALIAS_RE.test(match[1]) || !boundedText(match[2], 128)) return undefined;
  return { namespace: match[1], agentId: match[2] };
}

export async function deriveCrossProcessScope(options = {}) {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd())).catch(() => resolve(options.cwd ?? process.cwd()));
  const userId = options.uid ?? uid();
  const profile = String(options.profile ?? process.env.OMP_PROFILE ?? process.env.OMP_AGENT_DIR ?? 'default');
  const digest = createHash('sha256').update(`${userId}\0${profile}\0${cwd}`).digest('hex').slice(0, 32);
  const base = resolve(options.runtimeRoot ?? process.env.OMP_CROSS_PROCESS_IRC_RUNTIME_DIR
    ?? process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `omp-${userId}`));
  let runtimeDir = join(base, 'omp-cross-process-irc', digest);
  if (Buffer.byteLength(join(runtimeDir, 'broker.sock')) > 100) {
    runtimeDir = join(tmpdir(), `omp-${userId}`, 'omp-cross-process-irc', digest);
  }
  return {
    id: digest,
    uid: userId,
    runtimeDir,
    socketPath: join(runtimeDir, 'broker.sock'),
    tokenPath: join(runtimeDir, 'broker.token'),
  };
}

async function ensurePrivateDirectory(path, expectedUid) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Cross-process IRC runtime is not a private directory');
  if (typeof info.uid === 'number' && info.uid !== expectedUid) throw new Error('Cross-process IRC runtime has the wrong owner');
  await chmod(path, 0o700);
}

export async function readOrCreateToken(scope) {
  await ensurePrivateDirectory(scope.runtimeDir, scope.uid);
  try {
    const value = (await readFile(scope.tokenPath, 'utf8')).trim();
    const info = await stat(scope.tokenPath);
    if (!/^[a-f0-9]{64}$/.test(value) || (info.mode & 0o077) !== 0) throw new Error('Invalid cross-process IRC token file');
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const value = randomBytes(TOKEN_BYTES).toString('hex');
  try {
    const handle = await open(scope.tokenPath, 'wx', 0o600);
    try { await handle.writeFile(value, 'utf8'); } finally { await handle.close(); }
    return value;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readOrCreateToken(scope);
  }
}

export function authenticationProof(token, scopeId, instanceId, nonce) {
  return createHmac('sha256', token)
    .update(`${CROSS_PROCESS_IRC_PROTOCOL}\0${scopeId}\0${instanceId}\0${nonce}`)
    .digest('hex');
}

export function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new Error('Cross-process IRC frame exceeds limit');
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#buffer.length + next.length > MAX_PENDING_BYTES) throw new Error('Cross-process IRC receive buffer exceeds limit');
    this.#buffer = this.#buffer.length === 0 ? next : Buffer.concat([this.#buffer, next]);
    const frames = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error('Invalid cross-process IRC frame length');
      if (this.#buffer.length < length + 4) break;
      const body = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let value;
      try { value = JSON.parse(body.toString('utf8')); } catch { throw new Error('Invalid cross-process IRC frame JSON'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== CROSS_PROCESS_IRC_PROTOCOL) {
        throw new Error('Invalid cross-process IRC protocol frame');
      }
      frames.push(value);
    }
    return frames;
  }
}

function safeWrite(socket, frame) {
  if (!socket?.writable || socket.destroyed) return false;
  try {
    const encoded = encodeFrame(frame);
    if (socket.writableLength + encoded.length > MAX_PENDING_BYTES) {
      socket.destroy();
      return false;
    }
    socket.write(encoded);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

function publicAgents(agents) {
  if (!Array.isArray(agents) || agents.length > 256) throw new Error('Invalid agent roster');
  return agents.map((agent) => {
    if (!agent || typeof agent !== 'object') throw new Error('Invalid agent roster entry');
    const id = boundedText(agent.id, 128);
    const displayName = boundedText(agent.displayName, 128) ?? id;
    const kind = ['main', 'sub'].includes(agent.kind) ? agent.kind : undefined;
    const status = ['running', 'idle', 'parked'].includes(agent.status) ? agent.status : undefined;
    const sessionId = typeof agent.sessionId === 'string' && UUID_RE.test(agent.sessionId) ? agent.sessionId : undefined;
    if (!id || !kind || !status || !sessionId) throw new Error('Invalid agent roster entry');
    return {
      id, displayName, kind, status, sessionId,
      controlEnabled: agent.controlEnabled === true,
      ...(boundedText(agent.parentId, 128) ? { parentId: agent.parentId } : {}),
    };
  });
}

function cleanupBoundedMap(map, now = Date.now()) {
  for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
  while (map.size > DEDUPE_CAP) map.delete(map.keys().next().value);
}

export class CrossProcessBroker {
  constructor({ scope, token, now = Date.now }) {
    this.scope = scope;
    this.token = token;
    this.now = now;
    this.server = undefined;
    this.peers = new Map();
    this.pending = new Map();
    this.rosterGeneration = 0;
    this.leaseTimer = undefined;
    this.endpointIdentity = undefined;
    this.authNonces = new Map();
  }

  async listen() {
    this.server = createServer((socket) => this.#accept(socket));
    await new Promise((resolvePromise, reject) => {
      this.server.once('listening', resolvePromise);
      this.server.once('error', reject);
      this.server.listen(this.scope.socketPath);
    });
    await chmod(this.scope.socketPath, 0o600);
    const endpoint = await lstat(this.scope.socketPath);
    this.endpointIdentity = { dev: endpoint.dev, ino: endpoint.ino };
    this.leaseTimer = setInterval(() => this.#sweep(), HEARTBEAT_MS);
    this.leaseTimer.unref?.();
  }

  async close() {
    clearInterval(this.leaseTimer);
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.peers.clear();
    this.pending.clear();
    if (this.server?.listening) await new Promise((done) => this.server.close(() => done()));
    const endpoint = await lstat(this.scope.socketPath).catch(() => undefined);
    if (endpoint && this.endpointIdentity && endpoint.dev === this.endpointIdentity.dev && endpoint.ino === this.endpointIdentity.ino) {
      await rm(this.scope.socketPath, { force: true }).catch(() => {});
    }
  }

  #accept(socket) {
    const decoder = new FrameDecoder();
    let peer;
    const reject = () => socket.destroy();
    const timer = setTimeout(reject, 5_000);
    timer.unref?.();
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!peer) {
            if (frame.type !== 'hello') throw new Error('Authentication required');
            peer = this.#authenticate(socket, frame);
            clearTimeout(timer);
          } else {
            this.#handle(peer, frame);
          }
        }
      } catch { reject(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      if (peer && this.#withdraw(peer)) this.#rosterChanged();
    });
  }

  #withdraw(peer) {
    if (this.peers.get(peer.instanceId) !== peer) return false;
    this.peers.delete(peer.instanceId);
    this.#settlePendingFor(peer.instanceId);
    return true;
  }

  #settlePendingFor(instanceId) {
    for (const [key, pending] of this.pending) {
      if (pending.sender === instanceId) {
        this.pending.delete(key);
        continue;
      }
      if (pending.target !== instanceId) continue;
      this.pending.delete(key);
      const sender = this.peers.get(pending.sender);
      if (!sender) continue;
      safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL,
        type: pending.resultType ?? 'send_result',
        requestId: pending.requestId,
        ...(pending.messageId ? { messageId: pending.messageId } : {}),
        ...(pending.operationId ? { operationId: pending.operationId } : {}),
        outcome: 'delivery_unknown',
        ...(pending.resultType === 'configure_result'
          ? { code: 'target_disconnected' }
          : { error: 'Remote peer disconnected before acknowledging delivery' }),
      });
    }
  }

  #authenticate(socket, frame) {
    const instanceId = boundedText(frame.instanceId, 64);
    const nonce = boundedText(frame.nonce, 128);
    const proof = boundedText(frame.proof, 128);
    const alias = sanitizeAlias(frame.alias, instanceId?.slice(0, 8));
    if (!instanceId || !nonce || !proof || frame.scope !== this.scope.id || !alias) throw new Error('Authentication failed');
    const expected = authenticationProof(this.token, this.scope.id, instanceId, nonce);
    if (!constantTimeTextEqual(proof, expected)) throw new Error('Authentication failed');
    cleanupBoundedMap(this.authNonces, this.now());
    const nonceKey = `${instanceId}:${nonce}`;
    if (this.authNonces.has(nonceKey)) throw new Error('Authentication failed');
    this.authNonces.set(nonceKey, { expiresAt: this.now() + DEDUPE_TTL_MS });
    const previous = this.peers.get(instanceId);
    if (!previous && this.peers.size >= MAX_PEERS) throw new Error('Cross-process IRC peer limit reached');
    if (previous) {
      this.peers.delete(instanceId);
      this.#settlePendingFor(instanceId);
      previous.socket.destroy();
    }
    const peer = {
      instanceId,
      alias,
      namespace: this.#allocateNamespace(alias, instanceId),
      socket,
      agents: publicAgents(frame.agents ?? []),
      agentGeneration: Number.isSafeInteger(frame.agentGeneration) ? frame.agentGeneration : 0,
      lastSeen: this.now(),
    };
    this.peers.set(instanceId, peer);
    safeWrite(socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'hello_ack', namespace: peer.namespace });
    this.#rosterChanged();
    return peer;
  }

  #allocateNamespace(alias, instanceId) {
    const used = new Set([...this.peers.values()].map((peer) => peer.namespace));
    if (!used.has(alias)) return alias;
    const discriminator = createHash('sha256').update(instanceId).digest('hex').slice(0, 8);
    for (let index = 0; index < MAX_PEERS; index += 1) {
      const suffix = index === 0 ? discriminator : `${discriminator}-${index}`;
      const candidate = `${alias.slice(0, 47 - suffix.length)}-${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error('Unable to allocate a unique cross-process IRC namespace');
  }

  #handle(peer, frame) {
    peer.lastSeen = this.now();
    switch (frame.type) {
      case 'heartbeat': return;
      case 'roster': {
        if (!Number.isSafeInteger(frame.generation) || frame.generation <= peer.agentGeneration) return;
        peer.agents = publicAgents(frame.agents);
        peer.agentGeneration = frame.generation;
        this.#rosterChanged();
        return;
      }
      case 'send': this.#routeSend(peer, frame); return;
      case 'deliver_result': this.#routeResult(peer, frame); return;
      case 'configure': this.#routeConfigure(peer, frame); return;
      case 'configure_result': this.#routeConfigureResult(peer, frame); return;
      default: throw new Error('Unsupported cross-process IRC operation');
    }
  }

  #routeSend(sender, frame) {
    const requestId = boundedText(frame.requestId, 128);
    const messageId = boundedText(frame.messageId, 128);
    const toInstance = boundedText(frame.toInstance, 64);
    const toAgent = boundedText(frame.toAgent, 128);
    const fromAgent = boundedText(frame.fromAgent, 128);
    const body = boundedText(frame.body, 256 * 1024);
    if (!requestId || !messageId || !toInstance || !toAgent || !fromAgent || !body ||
        (frame.expectsReply !== undefined && typeof frame.expectsReply !== 'boolean') ||
        !sender.agents.some((agent) => agent.id === fromAgent)) {
      throw new Error('Invalid send frame');
    }
    const target = this.peers.get(toInstance);
    if (!target || !target.agents.some((agent) => agent.id === toAgent)) {
      safeWrite(sender.socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'send_result', requestId, messageId, outcome: 'failed', error: 'Remote peer is unavailable' });
      return;
    }
    if (this.pending.size >= DEDUPE_CAP) {
      safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL, type: 'send_result', requestId, messageId,
        outcome: 'failed', error: 'Cross-process IRC broker is busy',
      });
      return;
    }
    this.pending.set(`${sender.instanceId}:${requestId}`, {
      sender: sender.instanceId,
      target: target.instanceId,
      requestId,
      messageId,
      expiresAt: this.now() + DELIVERY_TIMEOUT_MS,
    });
    safeWrite(target.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL,
      type: 'deliver', requestId, messageId,
      routeKey: `${sender.instanceId}:${requestId}`,
      fromInstance: sender.instanceId,
      fromNamespace: sender.namespace,
      fromAgent, toAgent, body,
      ...(boundedText(frame.replyTo, 128) ? { replyTo: frame.replyTo } : {}),
      ...(frame.expectsReply === true ? { expectsReply: true } : {}),
    });
  }

  #routeResult(target, frame) {
    const routeKey = boundedText(frame.routeKey, 256);
    const pending = routeKey ? this.pending.get(routeKey) : undefined;
    if (!pending || pending.target !== target.instanceId) return;
    this.pending.delete(routeKey);
    const sender = this.peers.get(pending.sender);
    if (!sender) return;
    safeWrite(sender.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL,
      type: 'send_result', requestId: pending.requestId,
      messageId: pending.messageId,
      outcome: ['injected', 'woken', 'revived', 'failed'].includes(frame.outcome) ? frame.outcome : 'failed',
      ...(frame.outcome === 'failed' ? { error: 'Remote delivery failed' } : {}),
    });
  }

  #routeConfigure(sender, frame) {
    const requestId = boundedText(frame.requestId, 128);
    const operationId = boundedText(frame.operationId, 128);
    const sessionId = boundedText(frame.sessionId, 64);
    const model = frame.model === undefined ? undefined : boundedText(frame.model, 256);
    const effort = frame.effort === undefined ? undefined : boundedText(frame.effort, 32);
    if (!requestId || !operationId || !sessionId || !UUID_RE.test(sessionId) || (!model && !effort)) {
      throw new Error('Invalid configure frame');
    }
    const matches = [...this.peers.values()].filter((peer) =>
      peer.agents.some((agent) => agent.sessionId === sessionId));
    if (matches.length !== 1 || matches[0] === sender) {
      safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL, type: 'configure_result', requestId, operationId,
        outcome: 'failed', code: 'target_unavailable',
      });
      return;
    }
    const target = matches[0];
    const targetAgent = target.agents.find((agent) => agent.sessionId === sessionId);
    if (!targetAgent?.controlEnabled) {
      safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL, type: 'configure_result', requestId, operationId,
        outcome: 'failed', code: 'control_disabled',
      });
      return;
    }
    if (this.pending.size >= DEDUPE_CAP) {
      safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL, type: 'configure_result', requestId, operationId,
        outcome: 'failed', code: 'broker_busy',
      });
      return;
    }
    const routeKey = `${sender.instanceId}:${requestId}`;
    this.pending.set(routeKey, {
      sender: sender.instanceId, target: target.instanceId, requestId, operationId,
      resultType: 'configure_result', expiresAt: this.now() + DELIVERY_TIMEOUT_MS,
    });
    safeWrite(target.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL, type: 'configure_delivery', routeKey, requestId,
      fromInstance: sender.instanceId, operationId, sessionId,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    });
  }

  #routeConfigureResult(target, frame) {
    const routeKey = boundedText(frame.routeKey, 256);
    const pending = routeKey ? this.pending.get(routeKey) : undefined;
    if (!pending || pending.target !== target.instanceId || pending.resultType !== 'configure_result') return;
    this.pending.delete(routeKey);
    const sender = this.peers.get(pending.sender);
    if (!sender) return;
    const outcome = frame.outcome === 'configured' ? 'configured' : 'failed';
    safeWrite(sender.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL,
      type: 'configure_result',
      requestId: pending.requestId,
      operationId: pending.operationId,
      outcome,
      ...(boundedText(frame.model, 256) ? { model: frame.model } : {}),
      ...(boundedText(frame.effort, 32) ? { effort: frame.effort } : {}),
      ...(outcome === 'failed' ? {
        code: ['control_disabled', 'target_unavailable', 'unsupported_model', 'unsupported_effort', 'apply_failed', 'rollback_failed', 'operation_conflict'].includes(frame.code)
          ? frame.code
          : 'apply_failed',
      } : {}),
    });
  }

  #rosterChanged() {
    this.rosterGeneration += 1;
    for (const recipient of this.peers.values()) {
      const peers = [...this.peers.values()].filter((peer) => peer !== recipient).map((peer) => ({
        instanceId: peer.instanceId,
        namespace: peer.namespace,
        agents: peer.agents,
      }));
      safeWrite(recipient.socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'roster_snapshot', generation: this.rosterGeneration, peers });
    }
  }

  #sweep() {
    const now = this.now();
    let changed = false;
    for (const peer of [...this.peers.values()]) {
      if (now - peer.lastSeen <= LEASE_MS) continue;
      if (this.#withdraw(peer)) changed = true;
      peer.socket.destroy();
    }
    for (const [key, pending] of this.pending) {
      if (pending.expiresAt > now) continue;
      this.pending.delete(key);
      const sender = this.peers.get(pending.sender);
      if (sender) safeWrite(sender.socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL,
        type: pending.resultType ?? 'send_result',
        requestId: pending.requestId,
        ...(pending.messageId ? { messageId: pending.messageId } : {}),
        ...(pending.operationId ? { operationId: pending.operationId } : {}),
        outcome: 'delivery_unknown',
        ...(pending.resultType === 'configure_result' ? { code: 'timeout' } : {}),
      });
    }
    if (changed) this.#rosterChanged();
  }
}

async function endpointIsLive(path) {
  return new Promise((done) => {
    const socket = createConnection(path);
    const finish = (live) => { socket.destroy(); done(live); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function electBroker(scope, token, brokerFactory) {
  const broker = brokerFactory({ scope, token });
  try {
    await broker.listen();
    return broker;
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    const before = await lstat(scope.socketPath).catch(() => undefined);
    if (await endpointIsLive(scope.socketPath)) return undefined;
    const after = await lstat(scope.socketPath).catch(() => undefined);
    if (before?.isSocket() && after?.isSocket() && before.dev === after.dev && before.ino === after.ino) {
      await rm(scope.socketPath, { force: true });
    }
    try { await broker.listen(); return broker; } catch (retry) {
      if (retry?.code === 'EADDRINUSE') return undefined;
      throw retry;
    }
  }
}

export class CrossProcessClient {
  constructor({ scope, token, alias, instanceId = randomUUID(), agents, deliver, configure = async () => ({ outcome: 'failed', code: 'control_disabled' }), onRosterChange = () => {}, brokerFactory = (options) => new CrossProcessBroker(options), now = Date.now }) {
    this.scope = scope;
    this.token = token;
    this.alias = sanitizeAlias(alias, instanceId.slice(0, 8));
    this.instanceId = instanceId;
    this.agents = agents;
    this.deliver = deliver;
    this.configureDelivery = configure;
    this.onRosterChange = onRosterChange;
    this.brokerFactory = brokerFactory;
    this.now = now;
    this.socket = undefined;
    this.broker = undefined;
    this.decoder = new FrameDecoder();
    this.connected = false;
    this.namespace = undefined;
    this.roster = new Map();
    this.rosterGeneration = 0;
    this.agentGeneration = 1;
    this.pending = new Map();
    this.dedupe = new Map();
    this.controlDedupe = new Map();
    this.controlInFlight = new Map();
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    this.closed = false;
    this.deliveryQueue = Promise.resolve();
  }

  async start() { await this.#connect(); }

  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.socket?.destroy();
    await this.broker?.close();
  }

  publishRoster() {
    this.agentGeneration += 1;
    if (this.connected) safeWrite(this.socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'roster', generation: this.agentGeneration, agents: this.agents() });
  }

  list() {
    return [...this.roster.values()].flatMap((peer) => peer.agents.map((agent) => ({ ...agent, instanceId: peer.instanceId, namespace: peer.namespace, qualifiedId: `${peer.namespace}/${agent.id}` })));
  }

  resolveTarget(qualified) {
    const parsed = parseQualifiedIdentity(qualified);
    if (!parsed) return undefined;
    for (const peer of this.roster.values()) {
      if (peer.namespace !== parsed.namespace) continue;
      if (peer.agents.some((agent) => agent.id === parsed.agentId)) return { peer, agentId: parsed.agentId };
    }
    return undefined;
  }

  send({ fromAgent, to, body, replyTo, expectsReply = false, timeoutMs = DELIVERY_TIMEOUT_MS, messageId = randomUUID() }) {
    const target = this.resolveTarget(to);
    if (!target || !this.connected) return Promise.resolve({ outcome: 'failed', error: 'Remote peer is unavailable' });
    const requestId = randomUUID();
    const { promise, resolve: settle } = deferred();
    const timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      settle({ outcome: 'delivery_unknown', messageId });
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { settle, timer, messageId });
    if (!safeWrite(this.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL, type: 'send', requestId, messageId,
      toInstance: target.peer.instanceId, toAgent: target.agentId,
      fromAgent, body, ...(replyTo ? { replyTo } : {}),
      ...(expectsReply ? { expectsReply: true } : {}),
    })) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      settle({ outcome: 'delivery_unknown', messageId });
    }
    return promise;
  }

  configure({ sessionId, model, effort, timeoutMs = DELIVERY_TIMEOUT_MS, operationId = randomUUID() }) {
    if (!UUID_RE.test(sessionId) || (!model && !effort) || !this.connected) {
      return Promise.resolve({ outcome: 'failed', code: 'target_unavailable', operationId });
    }
    const matches = this.list().filter((agent) => agent.sessionId === sessionId);
    if (matches.length !== 1) return Promise.resolve({ outcome: 'failed', code: 'target_unavailable', operationId });
    if (!matches[0].controlEnabled) return Promise.resolve({ outcome: 'failed', code: 'control_disabled', operationId });
    const requestId = randomUUID();
    const { promise, resolve: settle } = deferred();
    const timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      settle({ outcome: 'delivery_unknown', code: 'timeout', operationId });
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { settle, timer, operationId });
    if (!safeWrite(this.socket, {
      v: CROSS_PROCESS_IRC_PROTOCOL, type: 'configure', requestId, operationId, sessionId,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    })) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      settle({ outcome: 'delivery_unknown', code: 'connection_lost', operationId });
    }
    return promise;
  }

  async #connect() {
    if (this.closed) return;
    await ensurePrivateDirectory(this.scope.runtimeDir, this.scope.uid);
    const elected = await electBroker(this.scope, this.token, this.brokerFactory);
    if (elected) this.broker = elected;
    const socket = createConnection(this.scope.socketPath);
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.deliveryQueue = Promise.resolve();
    socket.on('connect', () => {
      const nonce = randomBytes(32).toString('hex');
      safeWrite(socket, {
        v: CROSS_PROCESS_IRC_PROTOCOL, type: 'hello', scope: this.scope.id,
        instanceId: this.instanceId, alias: this.alias, nonce,
        proof: authenticationProof(this.token, this.scope.id, this.instanceId, nonce),
        agents: this.agents(), agentGeneration: this.agentGeneration,
      });
    });
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      const handle = (frame) => {
        if (this.socket !== socket || socket.destroyed) return Promise.resolve();
        return this.#handle(frame);
      };
      for (const frame of frames) {
        if (frame.type === 'deliver') {
          this.deliveryQueue = this.deliveryQueue
            .then(() => handle(frame))
            .catch(() => socket.destroy());
        } else {
          void handle(frame).catch(() => socket.destroy());
        }
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.namespace = undefined;
      this.roster.clear();
      this.rosterGeneration = 0;
      this.onRosterChange();
      clearInterval(this.heartbeatTimer);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.settle(pending.operationId
          ? { outcome: 'delivery_unknown', code: 'connection_lost', operationId: pending.operationId }
          : { outcome: 'delivery_unknown', messageId: pending.messageId });
        this.pending.delete(id);
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.#connect().catch(() => this.#scheduleReconnect());
    }, 250 + Math.floor(Math.random() * 250));
    this.reconnectTimer.unref?.();
  }

  async #handle(frame) {
    if (frame.type === 'hello_ack') {
      const namespace = boundedText(frame.namespace, 48);
      if (!namespace || !ALIAS_RE.test(namespace)) { this.socket.destroy(); return; }
      this.namespace = namespace;
      this.connected = true;
      this.heartbeatTimer = setInterval(() => safeWrite(this.socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'heartbeat' }), HEARTBEAT_MS);
      this.heartbeatTimer.unref?.();
      return;
    }
    if (!this.connected) throw new Error('Unauthenticated broker frame');
    if (frame.type === 'roster_snapshot') {
      if (!Number.isSafeInteger(frame.generation) || frame.generation <= this.rosterGeneration || !Array.isArray(frame.peers)) return;
      const next = new Map();
      for (const peer of frame.peers) {
        const instanceId = boundedText(peer.instanceId, 64);
        const namespace = boundedText(peer.namespace, 48);
        if (!instanceId || !namespace || !ALIAS_RE.test(namespace)) throw new Error('Invalid roster snapshot');
        next.set(instanceId, { instanceId, namespace, agents: publicAgents(peer.agents) });
      }
      this.roster = next;
      this.rosterGeneration = frame.generation;
      this.onRosterChange();
      return;
    }
    if (frame.type === 'send_result') {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.settle({ outcome: frame.outcome, messageId: frame.messageId ?? pending.messageId, ...(frame.error ? { error: frame.error } : {}) });
      return;
    }
    if (frame.type === 'configure_result') {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.settle({
        outcome: frame.outcome,
        operationId: frame.operationId ?? pending.operationId,
        ...(boundedText(frame.model, 256) ? { model: frame.model } : {}),
        ...(boundedText(frame.effort, 32) ? { effort: frame.effort } : {}),
        ...(boundedText(frame.code, 64) ? { code: frame.code } : {}),
      });
      return;
    }
    if (frame.type === 'configure_delivery') await this.#configure(frame);
    if (frame.type === 'deliver') await this.#deliver(frame);
  }

  async #deliver(frame) {
    const key = `${frame.fromInstance}:${frame.messageId}`;
    cleanupBoundedMap(this.dedupe, this.now());
    const cached = this.dedupe.get(key);
    if (cached) { safeWrite(this.socket, { ...cached.result, v: CROSS_PROCESS_IRC_PROTOCOL, type: 'deliver_result', routeKey: frame.routeKey }); return; }
    let result;
    try { result = await this.deliver(frame); } catch { result = { outcome: 'failed' }; }
    const safeResult = { messageId: frame.messageId, outcome: ['injected', 'woken', 'revived'].includes(result?.outcome) ? result.outcome : 'failed' };
    this.dedupe.set(key, { result: safeResult, expiresAt: this.now() + DEDUPE_TTL_MS });
    safeWrite(this.socket, { v: CROSS_PROCESS_IRC_PROTOCOL, type: 'deliver_result', routeKey: frame.routeKey, ...safeResult });
  }

  async #configure(frame) {
    const key = `${frame.fromInstance}:${frame.operationId}`;
    const fingerprint = createHash('sha256')
      .update(`${frame.sessionId}\0${frame.model ?? ''}\0${frame.effort ?? ''}`)
      .digest('hex');
    const now = this.now();
    cleanupBoundedMap(this.controlDedupe, now);
    cleanupBoundedMap(this.controlInFlight, now);
    const sendResult = (result) => safeWrite(this.socket, {
      ...result,
      v: CROSS_PROCESS_IRC_PROTOCOL,
      type: 'configure_result',
      routeKey: frame.routeKey,
    });
    const conflict = {
      operationId: frame.operationId,
      outcome: 'failed',
      code: 'operation_conflict',
    };
    const cached = this.controlDedupe.get(key);
    if (cached) {
      sendResult(cached.fingerprint === fingerprint ? cached.result : conflict);
      return;
    }
    const inFlight = this.controlInFlight.get(key);
    if (inFlight) {
      sendResult(inFlight.fingerprint === fingerprint ? await inFlight.promise : conflict);
      return;
    }
    const apply = (async () => {
      let result;
      try {
        result = await this.configureDelivery(frame);
      } catch {
        result = { outcome: 'failed', code: 'apply_failed' };
      }
      return {
        operationId: frame.operationId,
        outcome: result?.outcome === 'configured' ? 'configured' : 'failed',
        ...(boundedText(result?.model, 256) ? { model: result.model } : {}),
        ...(boundedText(result?.effort, 32) ? { effort: result.effort } : {}),
        ...(result?.outcome === 'configured' ? {} : { code: boundedText(result?.code, 64) ?? 'apply_failed' }),
      };
    })();
    const pending = { fingerprint, promise: apply, expiresAt: now + DEDUPE_TTL_MS };
    this.controlInFlight.set(key, pending);
    const safeResult = await apply;
    if (this.controlInFlight.get(key) === pending) this.controlInFlight.delete(key);
    this.controlDedupe.set(key, { fingerprint, result: safeResult, expiresAt: this.now() + DEDUPE_TTL_MS });
    cleanupBoundedMap(this.controlDedupe, this.now());
    sendResult(safeResult);
  }
}

function hubSchema(api) {
  const z = api.zod;
  return z.object({
    op: z.enum(['send', 'wait', 'inbox', 'list', 'configure', 'jobs', 'cancel', 'start', 'ps', 'logs', 'stop', 'restart', 'describe']),
    to: z.string().optional(), message: z.string().optional(), replyTo: z.string().optional(), await: z.boolean().optional(),
    from: z.string().optional(), ids: z.array(z.string()).optional(), timeoutMs: z.number().optional(), peek: z.boolean().optional(),
    sessionId: z.string().optional(), model: z.string().optional(), effort: z.string().optional(),
    name: z.string().optional(), application: z.string().optional(), args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(), pty: z.boolean().optional(),
    ready: z.object({ log: z.string().optional(), port: z.number().optional(), host: z.string().optional(), timeout: z.number().optional() }).optional(),
    restart: z.enum(['no', 'on-failure', 'always']).optional(), persist: z.boolean().optional(), detached: z.boolean().optional(),
    lines: z.number().optional(), head: z.boolean().optional(), grep: z.string().optional(), follow: z.boolean().optional(), cursor: z.number().optional(),
    for: z.enum(['ready', 'exit']).optional(), pattern: z.string().optional(), text: z.string().optional(), enter: z.boolean().optional(),
    keys: z.array(z.string()).optional(), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']).optional(), timeout: z.number().optional(),
  });
}

function textResult(text, details, isError = false) {
  return { content: [{ type: 'text', text }], details, ...(isError ? { isError: true } : {}) };
}
function modelCode(model) {
  return model && typeof model.provider === 'string' && typeof model.id === 'string'
    ? `${model.provider}/${model.id}`
    : undefined;
}

function supportedModelEfforts(model) {
  return model?.reasoning === true && Array.isArray(model.thinking?.efforts)
    ? model.thinking.efforts.filter((effort) => typeof effort === 'string')
    : [];
}

export class CrossProcessIrcRuntime {
  constructor({ api, scopeOptions, internals, clientFactory, controlEnabled = process.env[CROSS_PROCESS_IRC_REMOTE_CONTROL_ENV] === '1' }) {
    this.api = api;
    this.scopeOptions = scopeOptions;
    this.internals = internals;
    this.clientFactory = clientFactory;
    this.controlEnabled = controlEnabled;
    this.contexts = new Map();
    this.contextScopes = new Map();
    this.agentScopes = new Map();
    this.agentSessionIds = new Map();
    this.client = undefined;
    this.registry = undefined;
    this.bus = undefined;
    this.unsubscribe = undefined;
    this.starting = undefined;
    this.waiters = new Map();
    this.failedInbox = new Map();
    this.pendingInboundIds = [];
    this.localReplyIds = new Map();
  }

  async bind(ctx) {
    const scope = await deriveCrossProcessScope({ cwd: ctx.cwd, ...this.scopeOptions });
    this.contexts.set(ctx.sessionManager, ctx);
    this.contextScopes.set(ctx.sessionManager, scope.id);
    await this.#ensureStarted(ctx, scope);
    this.client?.publishRoster();
  }

  async unbind(ctx) {
    this.contexts.delete(ctx.sessionManager);
    this.contextScopes.delete(ctx.sessionManager);
    this.client?.publishRoster();
    if (this.contexts.size !== 0) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.client?.close();
    this.client = undefined;
  }

  localAgentId(sessionManager) {
    return this.registry?.list().find((ref) => ref.session?.sessionManager === sessionManager)?.id;
  }

  agents() {
    if (!this.registry || !this.scope) return [];
    const refs = this.registry.list();
    const knownIds = new Set(refs.map((ref) => ref.id));
    for (const id of this.agentScopes.keys()) if (!knownIds.has(id)) this.agentScopes.delete(id);
    for (const id of this.agentSessionIds.keys()) if (!knownIds.has(id)) this.agentSessionIds.delete(id);
    const candidates = [];
    for (const ref of refs) {
      const liveScope = ref.session ? this.contextScopes.get(ref.session.sessionManager) : undefined;
      const liveSessionId = ref.session?.sessionManager?.getSessionId?.();
      if (liveScope) this.agentScopes.set(ref.id, liveScope);
      if (typeof liveSessionId === 'string' && UUID_RE.test(liveSessionId)) this.agentSessionIds.set(ref.id, liveSessionId);
      const id = boundedText(ref.id, 128);
      const sessionId = this.agentSessionIds.get(ref.id);
      if (!id || this.agentScopes.get(ref.id) !== this.scope.id || !sessionId ||
          !['main', 'sub'].includes(ref.kind) || !['running', 'idle', 'parked'].includes(ref.status)) continue;
      const priority = ref.kind === 'main' ? 0 : ref.status === 'running' ? 1 : ref.status === 'idle' ? 2 : 3;
      candidates.push({
        priority,
        lastActivity: Number.isFinite(ref.lastActivity) ? ref.lastActivity : 0,
        agent: {
          id,
          displayName: boundedText(ref.displayName, 128) ?? id,
          kind: ref.kind,
          status: ref.status,
          sessionId,
          controlEnabled: this.controlEnabled && ref.kind === 'main',
          ...(boundedText(ref.parentId, 128) ? { parentId: ref.parentId } : {}),
        },
      });
    }
    candidates.sort((left, right) =>
      left.priority - right.priority ||
      right.lastActivity - left.lastActivity ||
      left.agent.id.localeCompare(right.agent.id));
    return candidates.slice(0, MAX_AGENTS_PER_PEER).map((candidate) => candidate.agent);
  }

  async execute(params, ctx, signal) {
    const remoteTo = params.op === 'send' ? this.client?.resolveTarget(params.to) : undefined;
    const remoteFrom = params.op === 'wait' ? parseQualifiedIdentity(params.from) : undefined;
    if (params.op === 'list') {
      const local = await ctx.invokeTool(params, { signal });
      const remotes = this.client?.list() ?? [];
      if (remotes.length === 0) return local;
      const rows = remotes.map((peer) =>
        `- \`${peer.qualifiedId}\` — ${peer.status} ${peer.kind}; session \`${peer.sessionId}\`; remote control ${peer.controlEnabled ? 'enabled' : 'disabled'}`).join('\n');
      return textResult(`${local.content?.map((item) => item.text ?? '').join('\n') ?? ''}\n\n## Remote peers (${remotes.length})\n${rows}`, {
        ...(local.details ?? {}),
        remotePeers: remotes.map(({ qualifiedId, displayName, kind, status, parentId, sessionId, controlEnabled }) => ({
          id: qualifiedId, displayName, kind, status, sessionId, controlEnabled, ...(parentId ? { parentId } : {}),
        })),
      });
    }
    if (params.op === 'configure') return this.#configureRemote(params);
    if (params.op === 'send' && remoteTo) return this.#send(params, ctx, signal);
    if (params.op === 'wait' && remoteFrom) return this.#wait(params, ctx, signal);
    if (params.op === 'inbox') {
      const local = await ctx.invokeTool(params, { signal });
      const agentId = this.localAgentId(ctx.sessionManager);
      const remote = agentId ? [...(this.failedInbox.get(agentId) ?? [])] : [];
      if (!params.peek && agentId) this.failedInbox.delete(agentId);
      if (remote.length === 0) return local;
      return textResult(`${local.content?.map((item) => item.text ?? '').join('\n') ?? ''}\n${remote.map((msg) => `[${msg.id}] ${msg.from}: ${msg.body}`).join('\n')}`, { ...(local.details ?? {}), remoteInbox: remote });
    }
    return ctx.invokeTool(params, { signal });
  }

  async #send(params, ctx, signal) {
    if (typeof params.message !== 'string' || !params.message.trim()) return textResult('Remote message must not be empty.', { op: 'send' }, true);
    const fromAgent = this.localAgentId(ctx.sessionManager);
    if (!fromAgent) return textResult('Unable to resolve the calling agent identity.', { op: 'send' }, true);
    const messageId = randomUUID();
    const waiter = params.await ? this.#createWaiter(fromAgent, params.to, params.timeoutMs, signal) : undefined;
    const receipt = await this.client.send({
      fromAgent,
      to: params.to,
      body: params.message,
      replyTo: this.#translateReplyId(params.replyTo),
      expectsReply: params.await === true,
      timeoutMs: params.timeoutMs || DELIVERY_TIMEOUT_MS,
      messageId,
    });
    if (receipt.outcome === 'delivery_unknown') {
      waiter?.cancel();
      return textResult(`Delivery to ${params.to} is unknown; do not resend automatically.`, { op: 'send', to: params.to, messageId: receipt.messageId, outcome: receipt.outcome }, true);
    }
    if (receipt.outcome === 'failed') {
      waiter?.cancel();
      return textResult(`Remote delivery failed: ${receipt.error ?? 'peer unavailable'}`, { op: 'send', to: params.to, outcome: receipt.outcome }, true);
    }
    if (!waiter) return textResult(`Delivered to ${params.to} (${receipt.outcome}).`, { op: 'send', to: params.to, messageId: receipt.messageId, outcome: receipt.outcome });
    const reply = await waiter.promise;
    if (!reply) return textResult(`Delivered to ${params.to}, but no reply arrived.`, { op: 'send', to: params.to, messageId: receipt.messageId, outcome: receipt.outcome, waited: null });
    return textResult(`[${reply.id}] ${reply.from}: ${reply.body}`, { op: 'send', to: params.to, messageId: receipt.messageId, outcome: receipt.outcome, waited: reply });
  }

  async #wait(params, ctx, signal) {
    const agentId = this.localAgentId(ctx.sessionManager);
    if (!agentId) return textResult('Unable to resolve the calling agent identity.', { op: 'wait' }, true);
    const inbox = this.failedInbox.get(agentId) ?? [];
    const bufferedIndex = inbox.findIndex((message) => message.from === params.from);
    if (bufferedIndex >= 0) {
      const [reply] = inbox.splice(bufferedIndex, 1);
      if (inbox.length === 0) this.failedInbox.delete(agentId);
      return textResult(`[${reply.id}] ${reply.from}: ${reply.body}`, { op: 'wait', waited: reply });
    }
    if (!this.client.resolveTarget(params.from)) return textResult(`Remote peer ${params.from} is unavailable.`, { op: 'wait', waited: null }, true);
    const reply = await this.#createWaiter(agentId, params.from, params.timeoutMs, signal).promise;
    return reply ? textResult(`[${reply.id}] ${reply.from}: ${reply.body}`, { op: 'wait', waited: reply }) : textResult('No remote message arrived before timeout.', { op: 'wait', waited: null });
  }

  async #configureRemote(params) {
    const model = params.model === undefined ? undefined : boundedText(params.model, 256);
    const effort = params.effort === undefined ? undefined : boundedText(params.effort, 32);
    if (typeof params.sessionId !== 'string' || !UUID_RE.test(params.sessionId) || (!model && !effort)) {
      return textResult('Remote configure requires an exact session UUID and nonempty model and/or effort.', { op: 'configure' }, true);
    }
    const receipt = await this.client.configure({
      sessionId: params.sessionId,
      model,
      effort,
      timeoutMs: params.timeoutMs || DELIVERY_TIMEOUT_MS,
    });
    if (receipt.outcome !== 'configured') {
      const code = receipt.code ?? (receipt.outcome === 'delivery_unknown' ? 'timeout' : 'apply_failed');
      return textResult(`Remote configuration failed (${code}).`, {
        op: 'configure', sessionId: params.sessionId, outcome: receipt.outcome, code,
        operationId: receipt.operationId,
        ...(receipt.model ? { observedModel: receipt.model } : {}),
        ...(receipt.effort ? { observedEffort: receipt.effort } : {}),
      }, true);
    }
    const effortText = receipt.effort ?? 'unset';
    return textResult(`Configured session ${params.sessionId}: model ${receipt.model}; effort ${effortText}.`, {
      op: 'configure', sessionId: params.sessionId, outcome: 'configured',
      operationId: receipt.operationId, model: receipt.model,
      ...(receipt.effort ? { effort: receipt.effort } : {}),
    });
  }

  #createWaiter(agentId, from, timeoutMs = 120_000, signal) {
    const key = agentId;
    const { promise, resolve: settle } = deferred();
    const waiter = { from, settle: () => {}, cancel: () => {} };
    const list = this.waiters.get(key) ?? [];
    list.push(waiter);
    this.waiters.set(key, list);
    let settled = false;
    let timer;
    let removeAbort;
    const remove = () => {
      const current = this.waiters.get(key) ?? [];
      const next = current.filter((item) => item !== waiter);
      if (next.length) this.waiters.set(key, next); else this.waiters.delete(key);
      removeAbort?.();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      settle(null);
    };
    waiter.cancel = cancel;
    waiter.settle = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      remove();
      settle(message);
    };
    timer = timeoutMs > 0 ? setTimeout(cancel, timeoutMs) : undefined;
    timer?.unref?.();
    if (signal?.aborted) cancel();
    else if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      removeAbort = () => signal.removeEventListener('abort', cancel);
    }
    return { promise, cancel };
  }

  async #deliver(frame) {
    const from = `${frame.fromNamespace}/${frame.fromAgent}`;
    const message = { id: frame.messageId, from, to: frame.toAgent, body: frame.body, ts: Date.now(), ...(frame.replyTo ? { replyTo: frame.replyTo } : {}) };
    const waiters = this.waiters.get(frame.toAgent) ?? [];
    const index = waiters.findIndex((waiter) => !waiter.from || waiter.from === from);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      if (waiters.length === 0) this.waiters.delete(frame.toAgent);
      waiter.settle(message);
      return { outcome: 'injected' };
    }
    const now = Date.now();
    this.pendingInboundIds = this.pendingInboundIds.filter((item) => item.expiresAt > now);
    while (this.pendingInboundIds.length >= DEDUPE_CAP) this.pendingInboundIds.shift();
    const pending = {
      from,
      toAgent: frame.toAgent,
      body: frame.body,
      wireId: frame.messageId,
      expiresAt: now + DEDUPE_TTL_MS,
    };
    this.pendingInboundIds.push(pending);
    const ref = this.registry?.get(frame.toAgent);
    let receipt;
    if (!ref) {
      receipt = { outcome: 'failed', error: `Unknown agent "${frame.toAgent}"` };
    } else if (ref.status === 'aborted' || ref.kind === 'advisor') {
      receipt = { outcome: 'failed', error: `Agent "${frame.toAgent}" cannot receive messages` };
    } else if (!ref.session) {
      receipt = { outcome: 'failed', error: `Agent "${frame.toAgent}" has no live session` };
    } else {
      try {
        receipt = {
          outcome: await ref.session.deliverIrcMessage(
            message,
            frame.expectsReply === true ? { expectsReply: true } : undefined,
          ),
        };
      } catch (error) {
        receipt = { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (receipt.outcome === 'failed') {
      this.pendingInboundIds = this.pendingInboundIds.filter((item) => item !== pending);
      const inbox = this.failedInbox.get(frame.toAgent) ?? [];
      inbox.push(message);
      if (inbox.length > 100) inbox.shift();
      this.failedInbox.set(frame.toAgent, inbox);
    }
    return receipt;
  }

  #configurationTarget(sessionId) {
    const matches = (this.registry?.list() ?? []).filter((ref) =>
      ref.kind === 'main' &&
      ref.status !== 'aborted' &&
      ref.session?.sessionManager?.getSessionId?.() === sessionId);
    if (matches.length !== 1) return undefined;
    const session = matches[0].session;
    const ctx = this.contexts.get(session.sessionManager);
    if (!ctx || this.contextScopes.get(session.sessionManager) !== this.scope?.id) return undefined;
    return { ctx, session };
  }

  #configuredEffort(session) {
    if (typeof session?.configuredThinkingLevel === 'function') {
      try {
        return session.configuredThinkingLevel();
      } catch {}
    }
    return this.api.getThinkingLevel();
  }

  async #configureSession(frame) {
    if (!this.controlEnabled) return { outcome: 'failed', code: 'control_disabled' };
    const target = this.#configurationTarget(frame.sessionId);
    if (!target) return { outcome: 'failed', code: 'target_unavailable' };
    const { ctx, session } = target;
    const observedFailure = (code) => ({
      outcome: 'failed',
      code,
      model: modelCode(ctx.models.current()),
      effort: this.#configuredEffort(session),
    });
    const originalModel = ctx.models.current();
    const originalEffort = this.#configuredEffort(session);
    let requestedModel;
    try {
      requestedModel = frame.model ? ctx.models.resolve(frame.model) : originalModel;
    } catch {
      return observedFailure('unsupported_model');
    }
    if (!requestedModel) return observedFailure('unsupported_model');
    const supportedEfforts = new Set(['off', 'auto', ...supportedModelEfforts(requestedModel)]);
    if (frame.effort && !supportedEfforts.has(frame.effort)) return observedFailure('unsupported_effort');
    const rollback = async () => {
      try {
        if (modelCode(ctx.models.current()) !== modelCode(originalModel)) {
          if (!originalModel || !(await this.api.setModel(originalModel))) return false;
        }
        this.api.setThinkingLevel(originalEffort);
        return modelCode(ctx.models.current()) === modelCode(originalModel) &&
          this.#configuredEffort(session) === originalEffort;
      } catch {
        return false;
      }
    };
    try {
      if (frame.model && !(await this.api.setModel(requestedModel))) {
        return observedFailure((await rollback()) ? 'apply_failed' : 'rollback_failed');
      }
      if (frame.effort) this.api.setThinkingLevel(frame.effort);
      const observedModel = modelCode(ctx.models.current());
      const observedEffort = this.#configuredEffort(session);
      if (!observedModel ||
          observedModel !== modelCode(requestedModel) ||
          (frame.effort && observedEffort !== frame.effort)) {
        return observedFailure((await rollback()) ? 'apply_failed' : 'rollback_failed');
      }
      return {
        outcome: 'configured',
        model: observedModel,
        ...(typeof observedEffort === 'string' ? { effort: observedEffort } : {}),
      };
    } catch {
      return observedFailure((await rollback()) ? 'apply_failed' : 'rollback_failed');
    }
  }

  observeMessage(event, ctx) {
    const message = event?.message;
    const details = message?.customType === 'irc:incoming' ? message.details : undefined;
    if (!details || typeof details.id !== 'string' || typeof details.from !== 'string' || typeof details.message !== 'string') return;
    const now = Date.now();
    this.pendingInboundIds = this.pendingInboundIds.filter((item) => item.expiresAt > now);
    cleanupBoundedMap(this.localReplyIds, now);
    const toAgent = this.localAgentId(ctx?.sessionManager);
    const index = this.pendingInboundIds.findIndex((item) =>
      item.toAgent === toAgent && item.from === details.from && item.body === details.message);
    if (index < 0) return;
    const [pending] = this.pendingInboundIds.splice(index, 1);
    this.localReplyIds.set(details.id, { wireId: pending.wireId, expiresAt: now + DEDUPE_TTL_MS });
  }

  #translateReplyId(replyTo) {
    if (typeof replyTo !== 'string') return undefined;
    cleanupBoundedMap(this.localReplyIds);
    return this.localReplyIds.get(replyTo)?.wireId ?? replyTo;
  }

  #settleDisconnectedWaiters() {
    for (const waiters of this.waiters.values()) {
      for (const waiter of [...waiters]) {
        if (waiter.from && !this.client?.resolveTarget(waiter.from)) waiter.cancel();
      }
    }
  }

  async #ensureStarted(ctx, scope = undefined) {
    scope ??= await deriveCrossProcessScope({ cwd: ctx.cwd, ...this.scopeOptions });
    if (this.client && this.scope?.id === scope.id) return;
    if (this.starting) {
      await this.starting;
      if (this.client && this.scope?.id === scope.id) return;
    }
    this.starting = (async () => {
      if (this.client) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await this.client.close();
        this.client = undefined;
      }
      const loaded = this.internals ? await this.internals() : {
        AgentRegistry: this.api.pi?.AgentRegistry,
      };
      if (!loaded.AgentRegistry) throw new Error('OMP agent registry export is unavailable');
      this.registry = loaded.AgentRegistry.global();
      const token = await readOrCreateToken(scope);
      const clientOptions = {
        scope,
        token,
        alias: process.env[CROSS_PROCESS_IRC_ALIAS_ENV],
        agents: () => this.agents(),
        deliver: (frame) => this.#deliver(frame),
        configure: (frame) => this.#configureSession(frame),
        onRosterChange: () => this.#settleDisconnectedWaiters(),
      };
      this.scope = scope;
      this.client = this.clientFactory ? this.clientFactory(clientOptions) : new CrossProcessClient(clientOptions);
      this.unsubscribe = this.registry.onChange(() => this.client?.publishRoster());
      await this.client.start();
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
}

export function installCrossProcessIrc(api, options = {}) {
  if ((options.enabled ?? process.env[CROSS_PROCESS_IRC_ENV] === '1') !== true) return undefined;
  const runtimeKey = options.runtimeKey ?? 'default';
  let runtime = options.runtime;
  if (!runtime) {
    runtime = runtimes.get(runtimeKey);
    if (!runtime) {
      runtime = new CrossProcessIrcRuntime({ api, scopeOptions: options.scopeOptions, internals: options.internals, clientFactory: options.clientFactory });
      runtimes.set(runtimeKey, runtime);
    }
  }
  api.registerTool({
    name: 'hub', label: 'Hub',
    description: 'Message local and qualified same-host peer agents, control background jobs, and supervise long-running processes. Remote peers use namespace/agent identities; process and lifecycle operations remain local.',
    parameters: hubSchema(api),
    strict: true,
    loadMode: 'essential',
    approval: (params) => {
      if (!params || typeof params !== 'object') return 'exec';
      if (['wait', 'inbox', 'list', 'jobs', 'cancel', 'ps', 'logs', 'describe'].includes(params.op)) return 'read';
      if (params.op === 'send') return typeof params.name === 'string' && params.name.length > 0 && !params.to ? 'exec' : 'read';
      return 'exec';
    },
    interruptible: (params) => params?.op === 'wait' || (params?.op === 'logs' && params?.follow === true),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) { return runtime.execute(params, ctx, signal); },
  });
  api.on('session_start', async (_event, ctx) => runtime.bind(ctx));
  api.on('session_switch', async (_event, ctx) => runtime.bind(ctx));
  api.on('message_start', async (event, ctx) => runtime.observeMessage(event, ctx));
  api.on('session_shutdown', async (_event, ctx) => runtime.unbind(ctx));
  return runtime;
}

export function resetCrossProcessIrcForTests() {
  runtimes.clear();
}
