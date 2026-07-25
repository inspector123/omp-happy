/**
 * Minimal port of happy-app's message normalization
 * (packages/happy-app/sources/sync/typesRaw.ts normalizeRawMessage + the
 * reducer's output shape in typesMessage.ts) down to the desktop MessageView
 * contract: roles user/agent/system, kinds text/thinking/tool/event, tool
 * calls collapsed to a one-line summary. The decrypted raw payload is kept on
 * MessageView.raw for future rich renderers.
 */

import type { MessageView, ToolData } from './types';

export interface SourceMessageInfo {
  id: string;
  localId: string | null;
  createdAt: number;
  seq: number;
}

export interface NormalizedView {
  view: MessageView;
  /** Present when the record is part of an appendable agent stream (ACP message/thinking). */
  stream?: { streamId: string; append: boolean };
  /** Server localId echo — used to replace optimistic outbox copies. */
  localId?: string | null;
  /** When present, this NormalizedView carries a tool-result to correlate with an existing tool-call by callId. */
  toolResult?: { callId: string; result: unknown; error: boolean };
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Collapse a tool call to a one-line summary (name + the most salient input field). */
export function summarizeToolCall(name: string, input: unknown): string {
  if (!isRecord(input)) {
    return name;
  }
  const detail =
    asString(input.command) ??
    asString(input.file_path) ??
    asString(input.filePath) ??
    asString(input.notebook_path) ??
    asString(input.pattern) ??
    asString(input.path) ??
    asString(input.url) ??
    asString(input.query) ??
    asString(input.description) ??
    asString(input.prompt);
  if (detail !== null) {
    return `${name}: ${oneLine(detail)}`;
  }
  try {
    return `${name}: ${oneLine(JSON.stringify(input))}`;
  } catch {
    return name;
  }
}

function view(
  base: SourceMessageInfo,
  id: string,
  role: MessageView['role'],
  kind: MessageView['kind'],
  text: string,
  raw: unknown,
  createdAt?: number,
  toolData?: ToolData,
  subagentId?: string,
): MessageView {
  const out: MessageView = {
    id,
    seq: base.seq,
    createdAt: createdAt ?? base.createdAt,
    role,
    kind,
    text,
    raw,
  };
  if (toolData) out.toolData = toolData;
  if (subagentId) out.subagentId = subagentId;
  return out;
}

function push(
  out: NormalizedView[],
  v: MessageView,
  stream?: { streamId: string; append: boolean },
  toolResult?: NormalizedView['toolResult'],
): void {
  const entry: NormalizedView = { view: v };
  if (stream) entry.stream = stream;
  if (toolResult) entry.toolResult = toolResult;
  out.push(entry);
}

/**
 * Normalize one decrypted raw record into zero or more MessageViews.
 * Returns an empty array for payloads that carry no renderable content
 * (lifecycle events, tool results, malformed records).
 */
export function normalizeDecryptedMessage(base: SourceMessageInfo, raw: unknown): NormalizedView[] {
  const out: NormalizedView[] = [];
  if (!isRecord(raw)) {
    return out;
  }
  const role = raw.role;
  const content = raw.content;
  if (!isRecord(content)) {
    return out;
  }

  if (role === 'user') {
    if (content.type === 'text' && typeof content.text === 'string') {
      push(out, view(base, base.id, 'user', 'text', content.text, raw));
    }
    return out;
  }

  if (role === 'session') {
    normalizeSessionEnvelope(base, content, raw, out);
    return out;
  }

  if (role !== 'agent') {
    return out;
  }

  const type = content.type;
  const data = content.data;

  if (type === 'output' && isRecord(data)) {
    normalizeAgentOutput(base, data, raw, out);
    return out;
  }

  if ((type === 'acp' || type === 'codex') && isRecord(data)) {
    normalizeAcpLike(base, data, raw, out);
    return out;
  }

  if (type === 'event') {
    push(out, view(base, base.id, 'system', 'event', eventSummary(data), raw));
    return out;
  }

  return out;
}

function eventSummary(data: unknown): string {
  if (isRecord(data)) {
    const t = asString(data.type);
    if (t) return t;
  }
  try {
    return oneLine(JSON.stringify(data) ?? 'event');
  } catch {
    return 'event';
  }
}

function normalizeAgentOutput(base: SourceMessageInfo, data: Rec, raw: unknown, out: NormalizedView[]): void {
  const dataType = data.type;

  if (dataType === 'assistant' && isRecord(data.message)) {
    const blocks = Array.isArray(data.message.content) ? data.message.content : [];
    let index = 0;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const id = `${base.id}:${index}`;
      index += 1;
      if (block.type === 'text' && typeof block.text === 'string') {
        push(out, view(base, id, 'agent', 'text', block.text, raw));
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        push(out, view(base, id, 'agent', 'thinking', block.thinking, raw));
      } else if (block.type === 'tool_use' || block.type === 'tool-call') {
        const name = asString(block.name) ?? 'unknown';
        const callId = asString(block.callId);
        const toolData: ToolData = { name, input: block.input };
        if (callId) toolData.callId = callId;
        push(out, view(base, id, 'agent', 'tool', summarizeToolCall(name, block.input), raw, undefined, toolData));
      }
      // tool_result / tool-call-result blocks: covered by the tool-call summary line.
    }
    return;
  }

  if (dataType === 'user' && isRecord(data.message)) {
    const content = data.message.content;
    if (typeof content === 'string') {
      push(out, view(base, `${base.id}:0`, 'user', 'text', content, raw));
      return;
    }
    if (Array.isArray(content)) {
      // Tool results are agent tool lifecycle, not human input — skip them.
      const textParts: string[] = [];
      for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        push(out, view(base, `${base.id}:0`, 'user', 'text', textParts.join('\n'), raw));
      }
    }
    return;
  }

  if (dataType === 'result') {
    const text = asString(data.result) ?? (data.is_error ? 'error' : 'result');
    push(out, view(base, base.id, 'system', 'event', text, raw));
    return;
  }

  if (dataType === 'summary' && typeof data.summary === 'string') {
    push(out, view(base, base.id, 'system', 'event', data.summary, raw));
    return;
  }

  if (dataType === 'system') {
    push(out, view(base, base.id, 'system', 'event', 'system', raw));
    return;
  }
}

function normalizeAcpLike(base: SourceMessageInfo, data: Rec, raw: unknown, out: NormalizedView[]): void {
  const dataType = data.type;

  if (dataType === 'message' && typeof data.message === 'string') {
    const streamId = asString(data.streamId);
    push(
      out,
      view(base, streamId ? `stream:${streamId}` : base.id, 'agent', 'text', data.message, raw),
      streamId ? { streamId, append: data.append === true } : undefined,
    );
    return;
  }

  if (dataType === 'thinking' && typeof data.text === 'string') {
    const streamId = asString(data.streamId);
    push(
      out,
      view(base, streamId ? `stream:${streamId}` : base.id, 'agent', 'thinking', data.text, raw),
      streamId ? { streamId, append: data.append === true } : undefined,
    );
    return;
  }

  if (dataType === 'reasoning' && typeof data.message === 'string') {
    push(out, view(base, base.id, 'agent', 'thinking', data.message, raw));
    return;
  }

  if (dataType === 'tool-call') {
    const name = asString(data.name) ?? 'unknown';
    const callId = asString(data.callId);
    const toolData: ToolData = { name, input: data.input };
    if (callId) toolData.callId = callId;
    push(out, view(base, base.id, 'agent', 'tool', summarizeToolCall(name, data.input), raw, undefined, toolData));
    return;
  }

  if (dataType === 'tool-result' || dataType === 'tool-call-result') {
    const callId = asString(data.callId);
    if (!callId) return; // can't correlate without callId
    const isError = data.is_error === true || data.error === true;
    push(out, view(base, base.id, 'agent', 'tool', '', raw), undefined, {
      callId, result: data.output ?? data, error: isError,
    });
    return;
  }

  if (dataType === 'file-edit') {
    const name = asString(data.filePath) ?? asString(data.description) ?? 'file';
    push(out, view(base, base.id, 'agent', 'tool', `Edit: ${oneLine(name)}`, raw));
    return;
  }

  // terminal-output / task_started / task_complete / turn_aborted /
  // permission-request / advisor / token_count: not rendered.
}

function normalizeSessionEnvelope(base: SourceMessageInfo, content: Rec, raw: unknown, out: NormalizedView[]): void {
  // Accept both the canonical wrapped shape ({ type:'session', data: envelope })
  // and the bare envelope ({ id, role, ev }).
  const envelope = content.type === 'session' && isRecord(content.data) ? content.data : content;
  const ev = isRecord(envelope.ev) ? envelope.ev : null;
  const id = asString(envelope.id) ?? base.id;
  const time = typeof envelope.time === 'number' ? envelope.time : base.createdAt;
  const subagentId = asString(envelope.subagent) ?? undefined;
  if (!ev) {
    return;
  }

  if (ev.t === 'text' && typeof ev.text === 'string') {
    if (envelope.role === 'user') {
      push(out, view(base, id, 'user', 'text', ev.text, raw, time, undefined, subagentId));
    } else if (envelope.role === 'agent') {
      push(out, view(base, id, 'agent', ev.thinking === true ? 'thinking' : 'text', ev.text, raw, time, undefined, subagentId));
    }
    return;
  }

  if (ev.t === 'service' && typeof ev.text === 'string' && envelope.role === 'agent') {
    push(out, view(base, id, 'agent', 'text', ev.text, raw, time, undefined, subagentId));
    return;
  }

  if (ev.t === 'tool-call-start') {
    const name = asString(ev.name) ?? 'unknown';
    const callId = asString(ev.call);
    const toolData: ToolData = { name, input: ev.args };
    if (callId) toolData.callId = callId;
    push(out, view(base, id, 'agent', 'tool', summarizeToolCall(name, ev.args), raw, time, toolData, subagentId));
    return;
  }

  if (ev.t === 'tool-call-end' || ev.t === 'tool-call-result') {
    const callId = asString(ev.call);
    if (!callId) return;
    const isError = ev.is_error === true || ev.error === true;
    push(out, view(base, id, 'agent', 'tool', '', raw, time, undefined, subagentId), undefined, {
      callId, result: ev.output ?? ev, error: isError,
    });
    return;
  }

  if (ev.t === 'turn-end' && subagentId) {
    const status = ev.status === 'failed'
      ? 'failed'
      : ev.status === 'cancelled'
        ? 'aborted'
        : 'completed';
    push(out, view(base, id, 'system', 'event', '', raw, time, {
      name: '__lifecycle__', input: { status },
    }, subagentId));
    return;
  }

  if (ev.t === 'start' && subagentId) {
    push(out, view(base, `${subagentId}:start`, 'system', 'event', '', raw, time, {
      name: '__lifecycle__', input: { status: 'running' },
    }, subagentId));
    return;
  }

  if (ev.t === 'stop' && subagentId) {
    const isError = ev.exit_code !== undefined && ev.exit_code !== 0 || ev.error === true;
    push(out, view(base, `${subagentId}:stop`, 'system', 'event', '', raw, time, {
      name: '__lifecycle__', input: { status: isError ? 'failed' : 'completed' },
    }, subagentId));
    return;
  }

  // turn-start / turn-end / file: lifecycle or rich content not rendered.
}
