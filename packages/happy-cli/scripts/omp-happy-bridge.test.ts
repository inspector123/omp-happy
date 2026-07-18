import { describe, expect, it } from 'vitest';

// The bridge is intentionally plain ESM because native OMP loads it directly.
// @ts-expect-error TypeScript has no declaration for the runtime extension module.
import { formatAskResult, getModelSnapshot, getThinkingSnapshot, resolveModel, resolveRequestedModel } from './omp-happy-bridge.mjs';

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
});
