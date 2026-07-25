import { describe, it, expect } from 'vitest';
import { normalizeDecryptedMessage, summarizeToolCall } from './normalize';

const BASE = { id: 'srv-msg-1', localId: null, createdAt: 1700000000000, seq: 7 };

describe('summarizeToolCall', () => {
  it('renders known tools as one-line summaries', () => {
    expect(summarizeToolCall('Bash', { command: 'ls -la /tmp' })).toBe('Bash: ls -la /tmp');
    expect(summarizeToolCall('Read', { file_path: '/etc/hosts' })).toBe('Read: /etc/hosts');
    expect(summarizeToolCall('Edit', { filePath: 'src/a.ts' })).toBe('Edit: src/a.ts');
    expect(summarizeToolCall('Grep', { pattern: 'foo' })).toBe('Grep: foo');
    expect(summarizeToolCall('Task', { description: 'find things' })).toBe('Task: find things');
  });

  it('falls back to truncated JSON for unknown tools and collapses newlines', () => {
    const out = summarizeToolCall('CustomTool', { a: 1, note: 'line1\nline2' });
    expect(out).toMatch(/^CustomTool: /);
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(140);
  });

  it('handles missing input', () => {
    expect(summarizeToolCall('NoArgs', undefined)).toBe('NoArgs');
  });
});

describe('normalizeDecryptedMessage', () => {
  it('maps a plain user text record', () => {
    const raw = { role: 'user', content: { type: 'text', text: 'hello agent' }, meta: { sentFrom: 'web' } };
    const out = normalizeDecryptedMessage(BASE, raw);
    expect(out).toHaveLength(1);
    expect(out[0].view).toMatchObject({
      id: 'srv-msg-1', seq: 7, createdAt: 1700000000000,
      role: 'user', kind: 'text', text: 'hello agent',
    });
    expect(out[0].view.raw).toEqual(raw);
    expect(out[0].stream).toBeUndefined();
  });

  it('maps claude-style agent output with text, thinking, and tool_use blocks', () => {
    const raw = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude',
            content: [
              { type: 'thinking', thinking: 'let me think' },
              { type: 'text', text: 'here is the answer' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } },
            ],
          },
        },
      },
    };
    const out = normalizeDecryptedMessage(BASE, raw);
    expect(out.map(v => [v.view.role, v.view.kind, v.view.text])).toEqual([
      ['agent', 'thinking', 'let me think'],
      ['agent', 'text', 'here is the answer'],
      ['agent', 'tool', 'Bash: pwd'],
    ]);
    // ids are unique per block
    expect(new Set(out.map(v => v.view.id)).size).toBe(3);
  });

  it('includes callId in toolData for agent output tool_use blocks', () => {
    const raw = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', callId: 'c1', name: 'Read', input: { file_path: 'a.ts' } },
            ],
          },
        },
      },
    };
    const out = normalizeDecryptedMessage(BASE, raw);
    expect(out).toHaveLength(1);
    expect(out[0].view.toolData).toMatchObject({ callId: 'c1', name: 'Read', input: { file_path: 'a.ts' } });
  });

  it('maps hyphenated codex/gemini content inside agent output', () => {
    const raw = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'gpt',
            content: [
              { type: 'tool-call', callId: 'c1', name: 'Read', input: { file_path: 'a.ts' }, id: 'x' },
            ],
          },
        },
      },
    };
    const out = normalizeDecryptedMessage(BASE, raw);
    expect(out).toHaveLength(1);
    expect(out[0].view).toMatchObject({ role: 'agent', kind: 'tool', text: 'Read: a.ts' });
  });

  it('maps ACP message / thinking / reasoning with stream metadata', () => {
    const msg = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'omp', data: { type: 'message', message: 'chunk one', streamId: 's1', append: false } },
    });
    expect(msg[0].view).toMatchObject({ role: 'agent', kind: 'text', text: 'chunk one' });
    expect(msg[0].stream).toEqual({ streamId: 's1', append: false });

    const th = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'claude', data: { type: 'thinking', text: 'pondering', streamId: 's2', append: true } },
    });
    expect(th[0].view).toMatchObject({ role: 'agent', kind: 'thinking', text: 'pondering' });
    expect(th[0].stream).toEqual({ streamId: 's2', append: true });

    const re = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'codex', data: { type: 'reasoning', message: 'chain of thought' } },
    });
    expect(re[0].view).toMatchObject({ role: 'agent', kind: 'thinking', text: 'chain of thought' });
  });

  it('maps ACP tool-call to a tool summary with structured toolData', () => {
    const call = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'omp', data: { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'make' }, id: 'i1' } },
    });
    expect(call[0].view).toMatchObject({ role: 'agent', kind: 'tool', text: 'Bash: make' });
    expect(call[0].view.toolData).toMatchObject({ callId: 'c1', name: 'Bash', input: { command: 'make' } });
  });

  it('maps ACP tool-result to a NormalizedView with toolResult for correlation', () => {
    const result = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'omp', data: { type: 'tool-result', callId: 'c1', output: 'ok', id: 'i2' } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].toolResult).toMatchObject({ callId: 'c1', result: 'ok', error: false });
  });

  it('skips ACP tool-result without callId', () => {
    const result = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'omp', data: { type: 'tool-result', output: 'ok', id: 'i3' } },
    });
    expect(result).toHaveLength(0);
  });

  it('marks ACP tool-result with is_error flag', () => {
    const result = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'omp', data: { type: 'tool-result', callId: 'c2', output: 'failed', is_error: true, id: 'i4' } },
    });
    expect(result[0].toolResult).toMatchObject({ callId: 'c2', error: true });
  });

  it('maps ACP file-edit to a tool summary', () => {
    const out = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'acp', provider: 'claude', data: { type: 'file-edit', description: 'update foo', filePath: 'src/foo.ts', id: 'e1' } },
    });
    expect(out[0].view).toMatchObject({ role: 'agent', kind: 'tool' });
    expect(out[0].view.text).toContain('src/foo.ts');
  });

  it('maps codex-flavored records', () => {
    const msg = normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'codex says hi' } },
    });
    expect(msg[0].view).toMatchObject({ role: 'agent', kind: 'text', text: 'codex says hi' });

    const reasoning = normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'thinking…' } },
    });
    expect(reasoning[0].view).toMatchObject({ role: 'agent', kind: 'thinking' });

    const tool = normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'c', name: 'Grep', input: { pattern: 'x' }, id: 'i' } },
    });
    expect(tool[0].view).toMatchObject({ role: 'agent', kind: 'tool', text: 'Grep: x' });
  });

  it('maps session envelopes: user text, agent text, agent thinking, service, tool-call-start', () => {
    const wrap = (data: unknown) => ({ role: 'session', content: { type: 'session', data } });

    const userText = normalizeDecryptedMessage(BASE, wrap({
      id: 'e1', time: 1700000000001, role: 'user', ev: { t: 'text', text: 'from phone' },
    }));
    expect(userText[0].view).toMatchObject({ role: 'user', kind: 'text', text: 'from phone' });

    const agentText = normalizeDecryptedMessage(BASE, wrap({
      id: 'e2', time: 1700000000002, role: 'agent', turn: 't1', ev: { t: 'text', text: 'agent reply' },
    }));
    expect(agentText[0].view).toMatchObject({ role: 'agent', kind: 'text', text: 'agent reply' });

    const agentThinking = normalizeDecryptedMessage(BASE, wrap({
      id: 'e3', time: 1700000000003, role: 'agent', turn: 't1', ev: { t: 'text', text: 'hmm', thinking: true },
    }));
    expect(agentThinking[0].view).toMatchObject({ role: 'agent', kind: 'thinking', text: 'hmm' });

    const service = normalizeDecryptedMessage(BASE, wrap({
      id: 'e4', time: 1700000000004, role: 'agent', turn: 't1', ev: { t: 'service', text: 'Compacting conversation' },
    }));
    expect(service[0].view).toMatchObject({ role: 'agent', kind: 'text', text: 'Compacting conversation' });

    const toolStart = normalizeDecryptedMessage(BASE, wrap({
      id: 'e5', time: 1700000000005, role: 'agent', turn: 't1',
      ev: { t: 'tool-call-start', call: 'c1', name: 'Edit', args: { file_path: 'x.ts' }, description: null },
    }));
    expect(toolStart[0].view).toMatchObject({ role: 'agent', kind: 'tool', text: 'Edit: x.ts' });
    expect(toolStart[0].view.toolData).toMatchObject({ callId: 'c1', name: 'Edit', input: { file_path: 'x.ts' } });
  });

  it('also accepts the unwrapped session envelope shape', () => {
    const raw = { role: 'session', content: { id: 'e1', time: 1700000000001, role: 'user', ev: { t: 'text', text: 'hi' } } };
    const out = normalizeDecryptedMessage(BASE, raw);
    expect(out[0].view).toMatchObject({ role: 'user', kind: 'text', text: 'hi' });
  });

  it('skips lifecycle envelopes and acp lifecycle events', () => {
    const wrap = (data: unknown) => ({ role: 'session', content: { type: 'session', data } });
    expect(normalizeDecryptedMessage(BASE, wrap({ id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'turn-start' } }))).toHaveLength(0);
    expect(normalizeDecryptedMessage(BASE, wrap({ id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'turn-end' } }))).toHaveLength(0);
    expect(normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'acp', provider: 'omp', data: { type: 'task_started', id: 'x' } },
    })).toHaveLength(0);
    expect(normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'acp', provider: 'omp', data: { type: 'task_complete', id: 'x' } },
    })).toHaveLength(0);
  });

  it('maps agent result/summary/system outputs to system events', () => {
    const result = normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'output', data: { type: 'result', result: 'done', is_error: false } },
    });
    expect(result[0].view).toMatchObject({ role: 'system', kind: 'event', text: 'done' });

    const summary = normalizeDecryptedMessage(BASE, {
      role: 'agent', content: { type: 'output', data: { type: 'summary', summary: 'Chat about X' } },
    });
    expect(summary[0].view).toMatchObject({ role: 'system', kind: 'event', text: 'Chat about X' });
  });

  it('maps tool_result-only user output to nothing, plain string user output to user text', () => {
    const toolResult = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'output', data: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } } },
    });
    expect(toolResult).toHaveLength(0);

    const plain = normalizeDecryptedMessage(BASE, {
      role: 'agent',
      content: { type: 'output', data: { type: 'user', message: { role: 'user', content: 'typed in terminal' } } },
    });
    expect(plain[0].view).toMatchObject({ role: 'user', kind: 'text', text: 'typed in terminal' });
  });

  it('returns empty for unknown or malformed payloads', () => {
    expect(normalizeDecryptedMessage(BASE, null)).toHaveLength(0);
    expect(normalizeDecryptedMessage(BASE, 42)).toHaveLength(0);
    expect(normalizeDecryptedMessage(BASE, { role: 'weird', content: {} })).toHaveLength(0);
  });
});
