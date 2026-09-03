import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import type { EffortLevel } from '../../reasoning-effort.js';

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  options: [] as Array<Record<string, unknown>>,
  serviceTokens: [] as string[],
}));

vi.mock('../../inference/oxy-inference.js', () => {
  const client = () => ({
    respond: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.requests.push(request);
      mocks.options.push(options);
      return {
        output: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
        finishReason: 'stop',
        usage: [],
      };
    },
  });
  return {
    getOxyInferenceClient: client,
    buildOxyInferenceClientForServiceToken: (token: string) => {
      mocks.serviceTokens.push(token);
      return client();
    },
  };
});

function resolved(): ResolvedModel {
  return {
    routingProfileId: 'kaana-v1-thinking',
    provider: 'kaana',
    publisher: 'kaana',
    model: 'kaana-v1-thinking',
    modelId: 'kaana-v1-thinking',
    keyConfig: { provider: 'kaana', modelId: 'kaana-v1-thinking' },
    oxyInferenceTarget: {
      kind: 'routing_profile_id',
      routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802',
    },
    routingProfile: { id: 'kaana-v1-thinking' },
    isFallback: false,
  } as ResolvedModel;
}

async function requestFor(reasoningEffort: EffortLevel | null, serviceToken?: string): Promise<Record<string, unknown>> {
  const { config, clearFirstByteTimer } = buildBaseConfig({
    resolved: resolved(),
    body: {},
    convertedMessages: [{ role: 'user', content: 'hello' }],
    truncatedTools: {},
    reasoningEffort,
    systemPromptTokens: 0,
    streamState: { hasStreamedContent: false } as never,
    oxyUserId: 'oxy-user-id',
    serviceToken,
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
  mocks.options.length = 0;
  mocks.serviceTokens.length = 0;
});

describe('reasoning crosses the Oxy inference boundary', () => {
  it('keeps reasoning in the selected routing profile', async () => {
    expect(await requestFor('max')).toMatchObject({
      routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802',
    });
    expect(await requestFor('max')).not.toHaveProperty('routingProfile');
  });

  it('does not construct provider-specific options in Alia', async () => {
    const wire = JSON.stringify(await requestFor('max'));
    expect(wire).not.toContain('providerOptions');
    expect(wire).not.toContain('budgetTokens');
    expect(wire).not.toContain('thinkingConfig');
    expect(wire).not.toContain('reasoningEffort');
  });

  it('attributes the hosted turn to the authenticated Oxy user', async () => {
    await requestFor(null);
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'oxy-user-id' });
  });

  it('uses the exact verified product bearer for a product-agent turn', async () => {
    await requestFor(null, 'verified-product-service-token');
    expect(mocks.serviceTokens).toEqual(['verified-product-service-token']);
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'oxy-user-id' });
  });
});
