import { describe, expect, it, vi } from 'vitest';

// The bridge is intentionally plain ESM because native OMP loads it directly.
// @ts-expect-error TypeScript has no declaration for the runtime extension module.
import {
  calculateOmpTokensPerSecond,
  createUsageTelemetry,
  formatAskResult,
  getModelSnapshot,
  getThinkingSnapshot,
  resolveModel,
  resolveRequestedModel,
  resolveTuiCommand,
  selectAskTools,
  sendPromptCommand,
  setOmpSessionTitle,
} from './omp-happy-bridge.mjs';

describe('OMP Happy bridge models', () => {
  const models = [
    { provider: 'openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable' },
    { provider: 'gateway', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  ];

  it('publishes the current OMP model facade as canonical Happy metadata', () => {
    expect(getModelSnapshot({
      models: {
        list: () => models,
        current: () => models[1],
      },
    })).toEqual({
      models: [
        { code: 'openai/gpt-5.6-sol', value: 'GPT-5.6 Sol' },
        { code: 'anthropic/claude-opus-4-6', value: 'Claude Opus 4.6', description: 'Most capable' },
        { code: 'gateway/gpt-5.6-sol', value: 'GPT-5.6 Sol' },
      ],
      currentModel: 'anthropic/claude-opus-4-6',
    });
  });

  it('resolves canonical selections and rejects ambiguous short names', () => {
    expect(resolveModel(models, 'openai/gpt-5.6-sol')).toBe(models[0]);
    expect(resolveModel(models, 'claude-opus-4-6')).toBe(models[1]);
    expect(resolveModel(models, 'gpt-5.6-sol')).toBeUndefined();
  });

  it('uses OMP resolution when available and list matching as a compatibility fallback', () => {
    const roleModel = { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' };
    expect(resolveRequestedModel({
      list: () => models,
      resolve: (spec: string) => spec === 'smol' ? roleModel : undefined,
    }, 'smol')).toBe(roleModel);
    expect(resolveRequestedModel({ list: () => models }, 'openai/gpt-5.6-sol')).toBe(models[0]);
  });

  it('publishes thinking independently from the model catalog', () => {
    const currentModel = {
      ...models[0],
      thinking: { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    };
    expect(getThinkingSnapshot(
      { getThinkingLevel: () => 'high' },
      { models: { current: () => currentModel } },
    )).toEqual({
      thoughtLevels: [
        { code: 'off', value: 'Off' },
        { code: 'minimal', value: 'Minimal' },
        { code: 'low', value: 'Low' },
        { code: 'medium', value: 'Medium' },
        { code: 'high', value: 'High' },
        { code: 'xhigh', value: 'XHigh' },
        { code: 'max', value: 'Max' },
      ],
      currentThoughtLevel: 'high',
    });
    expect(getThinkingSnapshot(
      { getThinkingLevel: () => 'high' },
      { models: { current: () => models[0] } },
    )).toEqual({ thoughtLevels: [], currentThoughtLevel: undefined });
  });

  it('formats remote ask answers as an OMP ask result', () => {
    const questions = [
      {
        id: 'phone',
        question: 'Which phone?',
        options: [{ label: 'Pixel' }, { label: 'Samsung' }],
      },
      {
        id: 'features',
        question: 'Which features?',
        multi: true,
        options: [{ label: 'Models' }, { label: 'Thinking' }],
      },
    ];
    expect(formatAskResult(questions, {
      phone: 'Samsung',
      features: 'Models, Thinking',
    })).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ answers: { phone: 'Samsung', features: 'Models, Thinking' } }),
      }],
      details: {
        results: [
          {
            id: 'phone',
            question: 'Which phone?',
            options: ['Pixel', 'Samsung'],
            multi: false,
            selectedOptions: ['Samsung'],
          },
          {
            id: 'features',
            question: 'Which features?',
            options: ['Models', 'Thinking'],
            multi: true,
            selectedOptions: ['Models', 'Thinking'],
          },
        ],
      },
    });
  });

  it('separates typed Ask answers from predefined selections', () => {
    const questions = [
      {
        id: 'phone',
        question: 'Which phone?',
        options: [{ label: 'Pixel' }, { label: 'Samsung' }],
      },
      {
        id: 'features',
        question: 'Which features?',
        multi: true,
        options: [{ label: 'Models' }, { label: 'Thinking' }],
      },
    ];
    expect(formatAskResult(questions, {
      phone: 'Fairphone',
      features: ['Models', 'Custom themes'],
    }).details).toEqual({
      results: [
        {
          id: 'phone',
          question: 'Which phone?',
          options: ['Pixel', 'Samsung'],
          multi: false,
          selectedOptions: [],
          customInput: 'Fairphone',
        },
        {
          id: 'features',
          question: 'Which features?',
          options: ['Models', 'Thinking'],
          multi: true,
          selectedOptions: ['Models'],
          customInput: 'Custom themes',
        },
      ],
    });
  });

  it('keeps the app-backed ask active for either controller', () => {
    const activeTools = ['read', 'ask', 'happy_ask', 'bash'];
    expect(selectAskTools(activeTools, 'local')).toEqual(['read', 'happy_ask', 'bash']);
    expect(selectAskTools(activeTools, 'remote')).toEqual(['read', 'happy_ask', 'bash']);
    expect(selectAskTools(['read', 'bash'], 'local')).toEqual(['read', 'bash']);
    expect(selectAskTools(['read', 'bash'], 'remote')).toEqual(['read', 'bash']);
  });
  it('persists app-originated titles through OMP session naming', async () => {
    const setSessionName = vi.fn().mockResolvedValue(undefined);
    await expect(setOmpSessionTitle({ setSessionName }, undefined, '  Renamed from phone  '))
      .resolves.toBe('Renamed from phone');
    expect(setSessionName).toHaveBeenCalledWith('Renamed from phone');

    const fallback = vi.fn().mockResolvedValue(undefined);
    await expect(setOmpSessionTitle({}, { sessionManager: { setSessionName: fallback } }, 'Fallback title'))
      .resolves.toBe('Fallback title');
    expect(fallback).toHaveBeenCalledWith('Fallback title');
  });

  it('delivers bridge prompt images as exact OMP multimodal content', async () => {
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);

    await expect(sendPromptCommand({ sendUserMessage }, {
      type: 'prompt',
      text: 'Inspect this',
      deliverAs: 'steer',
      images: [
        { data: 'AQID', mimeType: 'image/png' },
        { data: 'BAUG', mimeType: 'image/jpeg' },
      ],
    })).resolves.toBe(true);

    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(sendUserMessage).toHaveBeenCalledWith([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'image', data: 'BAUG', mimeType: 'image/jpeg' },
      { type: 'text', text: 'Inspect this' },
    ], { deliverAs: 'steer' });
  });

  it('delivers image-only bridge prompts without a placeholder text block', async () => {
    const sendUserMessage = vi.fn().mockResolvedValue(undefined);

    await sendPromptCommand({ sendUserMessage }, {
      type: 'prompt',
      text: '',
      images: [{ data: 'AQID', mimeType: 'image/png' }],
    });

    expect(sendUserMessage).toHaveBeenCalledWith([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ], undefined);
  });

  it('resolves every goal action to a safe single-line TUI command', () => {
    expect(resolveTuiCommand({
      type: 'goal_command',
      action: 'set',
      objective: '  Ship the API\n\twithout \u001B[31m regressions  ',
    })).toBe('/goal set Ship the API without regressions');
    expect(resolveTuiCommand({ type: 'goal_command', action: 'show' })).toBe('/goal show');
    expect(resolveTuiCommand({ type: 'goal_command', action: 'pause' })).toBe('/goal pause');
    expect(resolveTuiCommand({ type: 'goal_command', action: 'resume' })).toBe('/goal resume');
    expect(resolveTuiCommand({ type: 'goal_command', action: 'drop' })).toBe('/goal drop');
    expect(resolveTuiCommand({ type: 'goal_command', action: 'invalid' })).toBeUndefined();
    expect(resolveTuiCommand({ type: 'goal_command', action: 'set' })).toBeUndefined();
    expect(resolveTuiCommand({
      type: 'goal_command',
      action: 'set',
      objective: ' \n\t ',
    })).toBeUndefined();
  });

});

describe('OMP Happy bridge usage telemetry', () => {
  const assistantMessage = (
    usage: Record<string, number>,
    timing: Record<string, number> = {},
  ) => ({
    role: 'assistant',
    ...timing,
    usage,
  });

  it('publishes authoritative OMP context values without reading context inside the cadence bound', () => {
    const telemetry = createUsageTelemetry();
    telemetry.startMessage(assistantMessage({
      input: 11,
      output: 23,
      cacheWrite: 5,
      cacheRead: 7,
      reasoningTokens: 13,
    }), 0);
    const getContextUsage = vi.fn(() => ({
      tokens: 97_654,
      contextWindow: 262_144,
      percent: 37.25,
    }));
    const ctx = { getContextUsage };

    expect(telemetry.takeFrame(ctx, { force: true, now: 0 })).toEqual({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 23,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 7,
      contextTokens: 97_654,
      contextWindow: 262_144,
      contextPercent: 37.25,
      tokensPerSecond: 0,
    });
    expect(telemetry.takeFrame(ctx, { now: 499 })).toBeUndefined();
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(telemetry.takeFrame(ctx, { now: 500 })).toEqual(expect.objectContaining({
      contextTokens: 97_654,
      contextWindow: 262_144,
      contextPercent: 37.25,
    }));
    expect(getContextUsage).toHaveBeenCalledTimes(2);
  });

  it('uses OMP message timing for live and completed throughput', () => {
    const telemetry = createUsageTelemetry();
    const ctx = {
      getContextUsage: () => ({ tokens: 12_000, contextWindow: 131_072, percent: 9.16 }),
    };
    const streamingMessage = assistantMessage(
      { input: 10, output: 120 },
      { timestamp: 1_000 },
    );

    expect(calculateOmpTokensPerSecond(streamingMessage, true, 1_050)).toBe(0);
    expect(calculateOmpTokensPerSecond(streamingMessage, true, 2_000)).toBe(120);
    expect(telemetry.startMessage(streamingMessage, 1_050)).toBe(true);
    expect(telemetry.takeFrame(ctx, { force: true, now: 0 })?.tokensPerSecond).toBe(0);
    expect(telemetry.updateMessage(streamingMessage, 2_000)).toBe(true);
    expect(telemetry.takeFrame(ctx, { force: true, now: 500 })?.tokensPerSecond).toBe(120);

    const completedMessage = assistantMessage(
      { input: 10, output: 120 },
      { timestamp: 1_000, duration: 1_500 },
    );
    expect(calculateOmpTokensPerSecond(completedMessage, false, 10_000)).toBe(80);
    expect(telemetry.endMessage(completedMessage, 10_000)).toBe(true);
    expect(telemetry.takeFrame(ctx, { force: true, now: 10_000 })?.tokensPerSecond).toBe(80);
  });

  it('preserves OMP completion throughput across tools and clears it for the next response', () => {
    const telemetry = createUsageTelemetry();
    const ctx = {
      getContextUsage: () => ({ tokens: 26_214, contextWindow: 262_144, percent: 10 }),
    };
    const completedMessage = assistantMessage(
      { input: 10, output: 120 },
      { timestamp: 1_000, duration: 2_000 },
    );

    expect(telemetry.startMessage(completedMessage, 3_000)).toBe(true);
    expect(telemetry.endMessage(completedMessage, 3_000)).toBe(true);
    expect(telemetry.takeFrame(ctx, { force: true, now: 3_000 })?.tokensPerSecond).toBe(60);

    expect(telemetry.startMessage({ role: 'toolResult' }, 4_000)).toBe(false);
    expect(telemetry.endMessage({ role: 'toolResult' }, 4_500)).toBe(false);
    expect(telemetry.takeFrame(ctx, { force: true, now: 4_500 })?.tokensPerSecond).toBe(60);

    expect(telemetry.startMessage(
      assistantMessage({ input: 10, output: 0 }, { timestamp: 5_000 }),
      5_000,
    )).toBe(true);
    expect(telemetry.takeFrame(ctx, { force: true, now: 5_000 })?.tokensPerSecond).toBe(0);
  });
});
