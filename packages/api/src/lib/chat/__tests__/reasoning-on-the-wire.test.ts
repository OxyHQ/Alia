import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import type { EffortLevel } from '../../reasoning-effort.js';

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../inference/oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async (request: Record<string, unknown>) => {
      mocks.requests.push(request);
      return {
        output: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
        finishReason: 'stop',
        usage: [],
      };
    },
  }),
}));

function resolved(): ResolvedModel {
  return {
    routingProfileId: 'kaana-v1-thinking',
    provider: 'kaana',
    publisher: 'kaana',
    model: 'kaana-v1-thinking',
    modelId: 'kaana-v1-thinking',
    keyConfig: { provider: 'kaana', modelId: 'kaana-v1-thinking' },
    oxyInferenceTarget: { kind: 'routing_profile', routingProfile: 'kaana-v1-thinking' },
    routingProfile: { id: 'kaana-v1-thinking' },
    isFallback: false,
  } as ResolvedModel;
}

async function requestFor(reasoningEffort: EffortLevel | null): Promise<Record<string, unknown>> {
  const { config, clearFirstByteTimer } = buildBaseConfig({
    resolved: resolved(),
    body: {},
    convertedMessages: [{ role: 'user', content: 'hello' }],
    truncatedTools: {},
    reasoningEffort,
    systemPromptTokens: 0,
    streamState: { hasStreamedContent: false } as never,
    onUsage: () => undefined,
  });
  clearFirstByteTimer();
  const { tools: _tools, ...call } = config as Record<string, unknown>;
  await generateText(call as Parameters<typeof generateText>[0]);
  const request = mocks.requests[0];
  if (request === undefined) throw new Error('Oxy received no inference request');
  return request;
}

beforeEach(() => {
  mocks.requests.length = 0;
});

describe('reasoning crosses the Oxy inference boundary', () => {
  it('keeps reasoning in the selected routing profile', async () => {
    expect(await requestFor('max')).toMatchObject({ routingProfile: 'kaana-v1-thinking' });
  });

  it('does not construct provider-specific options in Alia', async () => {
    const wire = JSON.stringify(await requestFor('max'));
    expect(wire).not.toContain('providerOptions');
    expect(wire).not.toContain('budgetTokens');
    expect(wire).not.toContain('thinkingConfig');
    expect(wire).not.toContain('reasoningEffort');
  });
});
