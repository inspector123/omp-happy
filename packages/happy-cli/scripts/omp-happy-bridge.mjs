import { createConnection } from 'node:net';

const SOCKET_ENV = 'OMP_HAPPY_BRIDGE_SOCKET';
const PROTOCOL_VERSION = 1;

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function') return undefined;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

export default function happyBridgeExtension(pi) {
  const socketPath = process.env[SOCKET_ENV];
  if (!socketPath) return;

  let socket;
  let connected = false;
  let buffer = '';
  let latestContext;
  const pendingFrames = [];
  let reconnectTimer;
  let connectedOnce = false;
  let shuttingDown = false;

  const send = (frame) => {
    let line;
    try {
      line = `${safeStringify(frame)}\n`;
    } catch {
      return;
    }
    if (connected && socket?.writable) socket.write(line);
    else pendingFrames.push(line);
  };

  const publishReady = (ctx) => {
    latestContext = ctx;
    send({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
    });
  };

  const handleCommand = async (command) => {
    if (!command || typeof command !== 'object') return;
    if (command.type === 'prompt' && typeof command.text === 'string') {
      const options = command.deliverAs === 'followUp' || command.deliverAs === 'steer'
        ? { deliverAs: command.deliverAs }
        : undefined;
      const images = Array.isArray(command.images)
        ? command.images.filter((image) => image
          && typeof image.data === 'string'
          && typeof image.mimeType === 'string')
        : [];
      const content = [
        ...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
        ...(command.text.length > 0 ? [{ type: 'text', text: command.text }] : []),
      ];
      pi.sendUserMessage(content.length === 1 && content[0].type === 'text' ? command.text : content, options);
      return;
    }
    if (command.type === 'abort') {
      latestContext?.abort();
      return;
    }
    if (command.type === 'set_model' && typeof command.spec === 'string' && latestContext) {
      const model = latestContext.models.resolve(command.spec);
      if (!model || !(await pi.setModel(model))) {
        send({ type: 'bridge_error', message: `Unable to select OMP model: ${command.spec}` });
      }
    }
  };

  const connect = () => {
    if (shuttingDown) return;
    socket = createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      buffer = '';
      for (const frame of pendingFrames.splice(0)) socket.write(frame);
      if (connectedOnce && latestContext) publishReady(latestContext);
      connectedOnce = true;
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          void handleCommand(JSON.parse(line)).catch((error) => {
            send({ type: 'bridge_error', message: error instanceof Error ? error.message : String(error) });
          });
        } catch {
          send({ type: 'bridge_error', message: 'Invalid bridge command JSON' });
        }
      }
    });
    socket.on('close', () => {
      connected = false;
      if (!shuttingDown && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, 250);
      }
    });
    socket.on('error', () => {
      connected = false;
      socket?.destroy();
    });
  };

  connect();

  pi.on('session_start', async (_event, ctx) => {
    publishReady(ctx);
  });
  pi.on('session_switch', async (event, ctx) => {
    publishReady(ctx);
    send({ type: 'agent_event', event });
  });
  pi.on('input', async (event, ctx) => {
    latestContext = ctx;
    send({ type: 'input', text: event.text, source: event.source, images: event.images });
  });

  for (const eventName of [
    'agent_start',
    'agent_end',
    'turn_start',
    'turn_end',
    'message_start',
    'message_update',
    'message_end',
    'tool_execution_start',
    'tool_execution_update',
    'tool_execution_end',
    'tool_approval_requested',
    'tool_approval_resolved',
    'session.compacting',
    'session_compact',
    'session_branch',
    'session_tree',
    'goal_updated',
  ]) {
    pi.on(eventName, async (event, ctx) => {
      latestContext = ctx;
      send({ type: 'agent_event', event });
    });
  }

  pi.on('session_shutdown', async (event, ctx) => {
    latestContext = ctx;
    send({ type: 'agent_event', event });
    shuttingDown = true;
    clearTimeout(reconnectTimer);
    socket?.end();
  });
}
