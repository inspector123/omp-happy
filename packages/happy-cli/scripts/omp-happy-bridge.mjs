import { createConnection } from 'node:net';

const SOCKET_ENV = 'OMP_HAPPY_BRIDGE_SOCKET';
const CONTROL_MODE_ENV = 'OMP_HAPPY_CONTROL_MODE';
const LOCAL_ASK_TOOL = 'ask';
const REMOTE_ASK_TOOL = 'happy_ask';
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

export function getModelSnapshot(ctx) {
  const modelFacade = ctx?.models;
  if (!modelFacade || typeof modelFacade.list !== 'function') {
    return { models: [], currentModel: undefined };
  }
  const available = modelFacade.list();
  const models = Array.isArray(available)
    ? available.flatMap((model) => {
        if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.provider !== 'string') {
          return [];
        }
        return [{
          code: `${model.provider}/${model.id}`,
          value: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
          ...(typeof model.description === 'string' && model.description.length > 0
            ? { description: model.description }
            : {}),
        }];
      })
    : [];
  const current = typeof modelFacade.current === 'function' ? modelFacade.current() : undefined;
  const currentModel = current
    && typeof current.id === 'string'
    && typeof current.provider === 'string'
    ? `${current.provider}/${current.id}`
    : undefined;
  return { models, currentModel };
}

export function resolveModel(models, spec) {
  if (!Array.isArray(models)) return undefined;
  const canonicalMatches = models.filter((model) => `${model.provider}/${model.id}` === spec);
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  const shortMatches = models.filter((model) => model.id === spec || model.name === spec);
  return shortMatches.length === 1 ? shortMatches[0] : undefined;
}

export function resolveRequestedModel(modelFacade, spec) {
  const available = typeof modelFacade?.list === 'function' ? modelFacade.list() : [];
  if (typeof modelFacade?.resolve === 'function') {
    return modelFacade.resolve(spec) ?? resolveModel(available, spec);
  }
  return resolveModel(available, spec);
}

const THINKING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export function getThinkingSnapshot(pi, ctx) {
  const currentModel = typeof ctx?.models?.current === 'function' ? ctx.models.current() : undefined;
  const efforts = Array.isArray(currentModel?.thinking?.efforts) ? currentModel.thinking.efforts : [];
  const thoughtLevels = efforts.length > 0
    ? ['off', ...efforts].flatMap((code) => (
        typeof code === 'string' && THINKING_LABELS[code]
          ? [{ code, value: THINKING_LABELS[code] }]
          : []
      ))
    : [];
  const reportedLevel = typeof pi?.getThinkingLevel === 'function' ? pi.getThinkingLevel() ?? 'off' : 'off';
  const currentThoughtLevel = thoughtLevels.some((level) => level.code === reportedLevel)
    ? reportedLevel
    : thoughtLevels.length > 0 ? 'off' : undefined;
  return { thoughtLevels, currentThoughtLevel };
}

export function formatAskResult(questions, answers) {
  const results = questions.map((question) => {
    const rawAnswer = answers[question.id] ?? answers[question.question] ?? '';
    const answer = Array.isArray(rawAnswer) ? rawAnswer : (rawAnswer ? String(rawAnswer).split(', ').filter(Boolean) : []);
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: question.multi === true,
      selectedOptions: answer,
    };
  });
  return {
    content: [{ type: 'text', text: JSON.stringify({ answers }) }],
    details: { results },
  };
}

export function selectAskTools(activeTools, mode) {
  const selectedAskTool = mode === 'remote' ? REMOTE_ASK_TOOL : LOCAL_ASK_TOOL;
  const askToolNames = new Set([LOCAL_ASK_TOOL, REMOTE_ASK_TOOL]);
  const nextTools = [];
  let insertedAskTool = false;
  for (const toolName of activeTools) {
    if (!askToolNames.has(toolName)) {
      nextTools.push(toolName);
      continue;
    }
    if (!insertedAskTool) {
      nextTools.push(selectedAskTool);
      insertedAskTool = true;
    }
  }
  return nextTools;
}

export async function sendPromptCommand(pi, command) {
  if (!command || typeof command !== 'object' || command.type !== 'prompt' || typeof command.text !== 'string') {
    return false;
  }
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
  await pi.sendUserMessage(content.length === 1 && content[0].type === 'text' ? command.text : content, options);
  return true;
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
  let commandQueue = Promise.resolve();
  let controlMode = process.env[CONTROL_MODE_ENV] === 'remote' ? 'remote' : 'local';
  const pendingAskRequests = new Map();


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
  const setControlMode = (mode) => {
    if (mode !== 'local' && mode !== 'remote') return false;
    controlMode = mode;
    if (typeof pi.getActiveTools === 'function' && typeof pi.setActiveTools === 'function') {
      const activeTools = pi.getActiveTools();
      const nextTools = selectAskTools(activeTools, controlMode);
      if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
        pi.setActiveTools(nextTools);
      }
    }
    return true;
  };
  if (typeof pi.registerTool === 'function') {
    const z = pi.zod;
    pi.registerTool({
      name: REMOTE_ASK_TOOL,
      label: 'Ask',
      description: 'Ask the user one or more questions during execution.',
      parameters: z.object({
        questions: z.array(z.object({
          id: z.string(),
          question: z.string(),
          header: z.string().optional(),
          options: z.array(z.object({
            label: z.string(),
            description: z.string().optional(),
            preview: z.string().optional(),
          })),
          multi: z.boolean().optional(),
          recommended: z.number().optional(),
        })).min(1),
      }),
      async execute(toolCallId, params, signal) {
        const answers = await new Promise((resolve, reject) => {
          const abort = () => {
            pendingAskRequests.delete(toolCallId);
            reject(new Error('Ask request aborted'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          pendingAskRequests.set(toolCallId, {
            resolve: (value) => {
              signal?.removeEventListener('abort', abort);
              resolve(value);
            },
          });
          send({ type: 'ask_request', id: toolCallId, questions: params.questions });
        });
        return formatAskResult(params.questions, answers);
      },
    });
    pi.registerTool({
      name: 'change_title',
      label: 'Change title',
      description: 'Change the title of the current Happy chat session.',
      parameters: z.object({
        title: z.string().min(1),
      }),
      async execute(_toolCallId, params) {
        const title = params.title.trim();
        if (!title) {
          return {
            content: [{ type: 'text', text: 'Title must not be empty.' }],
            isError: true,
          };
        }
        if (typeof pi.setSessionName === 'function') {
          await pi.setSessionName(title);
        } else if (typeof latestContext?.sessionManager?.setSessionName === 'function') {
          await latestContext.sessionManager.setSessionName(title);
        }
        send({ type: 'change_title', title });
        return {
          content: [{ type: 'text', text: `Changed Happy session title to "${title}".` }],
          details: { title, ompSessionName: typeof pi.getSessionName === 'function' ? pi.getSessionName() : title },
        };
      },
    });
  }



  const publishReady = (ctx) => {
    latestContext = ctx;
    const modelSnapshot = getModelSnapshot(ctx);
    const thinkingSnapshot = getThinkingSnapshot(pi, ctx);
    send({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      models: modelSnapshot.models,
      currentModel: modelSnapshot.currentModel,
      thoughtLevels: thinkingSnapshot.thoughtLevels,
      currentThoughtLevel: thinkingSnapshot.currentThoughtLevel,
      title: typeof pi.getSessionName === 'function'
        ? pi.getSessionName()
        : ctx.sessionManager.getSessionName?.(),
    });
  };

  const handleCommand = async (command) => {
    if (!command || typeof command !== 'object') return;
    if (await sendPromptCommand(pi, command)) {
      return;
    }
    if (command.type === 'set_control_mode') {
      if (!setControlMode(command.mode)) {
        send({ type: 'bridge_error', message: `Invalid OMP control mode: ${String(command.mode)}` });
      }
      return;
    }
    if (command.type === 'abort') {
      await latestContext?.abort();
      send({ type: 'aborted' });
      return;
    }
    if (command.type === 'set_model' && typeof command.spec === 'string' && latestContext) {
      const model = resolveRequestedModel(latestContext.models, command.spec);
      if (!model || !(await pi.setModel(model))) {
        send({ type: 'bridge_error', message: `Unable to select OMP model: ${command.spec}` });
      } else {
        publishReady(latestContext);
      }
    }
    if (command.type === 'set_thinking_level' && typeof command.level === 'string' && latestContext) {
      const snapshot = getThinkingSnapshot(pi, latestContext);
      if (!snapshot.thoughtLevels.some((level) => level.code === command.level)) {
        send({ type: 'bridge_error', message: `Unable to select OMP thinking level: ${command.level}` });
      } else {
        pi.setThinkingLevel(command.level);
        publishReady(latestContext);
      }
    }
    if (command.type === 'ask_response' && typeof command.id === 'string') {
      const pending = pendingAskRequests.get(command.id);
      if (!pending) {
        send({ type: 'bridge_error', message: `No pending OMP ask request: ${command.id}` });
        return;
      }
      pendingAskRequests.delete(command.id);
      pending.resolve(command.answers && typeof command.answers === 'object' ? command.answers : {});
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
          const command = JSON.parse(line);
          commandQueue = commandQueue
            .then(() => handleCommand(command))
            .catch((error) => {
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
    setControlMode(controlMode);
    publishReady(ctx);
  });
  pi.on('session_switch', async (event, ctx) => {
    publishReady(ctx);
    send({ type: 'agent_event', event });
  });
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'extension') setControlMode('local');
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
