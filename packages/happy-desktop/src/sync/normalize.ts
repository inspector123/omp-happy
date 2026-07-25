/**
 * Minimal port of happy-app's message normalization
 * (packages/happy-app/sources/sync/typesRaw.ts normalizeRawMessage + the
 * reducer's output shape in typesMessage.ts) down to the desktop MessageView
 * contract: roles user/agent/system, kinds text/thinking/tool/event, tool
 * calls collapsed to a one-line summary. The decrypted raw payload is kept on
 * MessageView.raw for future rich renderers.
 */

import type { MessageView } from './types';

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
): MessageView {
  return {
    id,
    seq: base.seq,
    createdAt: createdAt ?? base.createdAt,
    role,
    kind,
    text,
    raw,
  };
}

function push(out: NormalizedView[], v: MessageView, stream?: { streamId: string; append: boolean }): void {
  out.push(stream ? { view: v, stream } : { view: v });
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
        push(out, view(base, id, 'agent', 'tool', summarizeToolCall(name, block.input), raw));
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
    push(out, view(base, base.id, 'agent', 'tool', summarizeToolCall(name, data.input), raw));
    return;
  }

  if (dataType === 'file-edit') {
    const name = asString(data.filePath) ?? asString(data.description) ?? 'file';
    push(out, view(base, base.id, 'agent', 'tool', `Edit: ${oneLine(name)}`, raw));
    return;
  }

  // tool-result / tool-call-result / terminal-output / task_started /
  // task_complete / turn_aborted / permission-request / advisor / token_count:
  // not rendered in the minimal desktop view.
}

function normalizeSessionEnvelope(base: SourceMessageInfo, content: Rec, raw: unknown, out: NormalizedView[]): void {
  // Accept both the canonical wrapped shape ({ type:'session', data: envelope })
  // and the bare envelope ({ id, role, ev }).
  const envelope = content.type === 'session' && isRecord(content.data) ? content.data : content;
  const ev = isRecord(envelope.ev) ? envelope.ev : null;
  const id = asString(envelope.id) ?? base.id;
  const time = typeof envelope.time === 'number' ? envelope.time : base.createdAt;
  if (!ev) {
    return;
  }

  if (ev.t === 'text' && typeof ev.text === 'string') {
    if (envelope.role === 'user') {
      push(out, view(base, id, 'user', 'text', ev.text, raw, time));
    } else if (envelope.role === 'agent') {
      push(out, view(base, id, 'agent', ev.thinking === true ? 'thinking' : 'text', ev.text, raw, time));
    }
    return;
  }

  if (ev.t === 'service' && typeof ev.text === 'string' && envelope.role === 'agent') {
    push(out, view(base, id, 'agent', 'text', ev.text, raw, time));
    return;
  }

  if (ev.t === 'tool-call-start') {
    const name = asString(ev.name) ?? 'unknown';
    push(out, view(base, id, 'agent', 'tool', summarizeToolCall(name, ev.args), raw, time));
    return;
  }

  // turn-start / turn-end / start / stop / tool-call-end / file: lifecycle or
  // rich content not rendered by the minimal desktop view.
}
