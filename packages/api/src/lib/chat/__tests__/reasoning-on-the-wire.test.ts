import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import type { ReasoningEffort } from '../../models/catalogue.js';

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
        requestId: 'req-wire',
        model: 'openai/gpt-5-mini@2026-08-18',
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
    provider: 'kaana',
    publisher: 'acme',
    model: 'thinker-1',
    modelId: 'acme/thinker-1',
    keyConfig: { provider: 'kaana', modelId: 'acme/thinker-1' },
    oxyInferenceTarget: { kind: 'model', model: 'acme/thinker-1' },
    catalogue: null,
  };
}

async function requestFor(reasoningEffort: ReasoningEffort | null, serviceToken?: string): Promise<Record<string, unknown>> {
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
  it('sends the selected model with the effort as reasoning.effort', async () => {
    const request = await requestFor('high');
    expect(request).toMatchObject({ model: 'acme/thinker-1', reasoning: { effort: 'high' } });
    expect(request).not.toHaveProperty('routingProfileId');
    expect(request).not.toHaveProperty('routingProfile');
  });

  it('sends no reasoning field when no effort was asked for', async () => {
    expect(await requestFor(null)).not.toHaveProperty('reasoning');
  });

  it('does not construct provider-specific options in Alia', async () => {
    const wire = JSON.stringify(await requestFor('medium'));
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

describe('the served revision comes back off the wire', () => {
  it('hands providerMetadata.kaana.resolvedModelReference to onResolvedModel from onFinish', async () => {
    /**
     * The one seam between the adapter and the usage record: `ai@6` hands the
     * final step's `providerMetadata` to `onFinish`, and `buildBaseConfig` has to
     * read the adapter's namespace there. Driven through the REAL `generateText`
     * so the test fails if the SDK stops forwarding the field, not only if this
     * repository stops reading it.
     */
    const seen: string[] = [];
    const { config, clearFirstByteTimer } = buildBaseConfig({
      resolved: resolved(),
      body: {},
      convertedMessages: [{ role: 'user', content: 'hello' }],
      truncatedTools: {},
      reasoningEffort: null,
      systemPromptTokens: 0,
      streamState: { hasStreamedContent: false } as never,
      oxyUserId: 'oxy-user-id',
      onUsage: () => undefined,
      onResolvedModel: (reference) => { seen.push(reference); },
    });
    clearFirstByteTimer();
    const { tools: _tools, ...call } = config as Record<string, unknown>;
    await generateText(call as Parameters<typeof generateText>[0]);

    expect(seen).toEqual(['openai/gpt-5-mini@2026-08-18']);
    // The served revision, never the requested model echoed back.
    expect(seen[0]).not.toBe('acme/thinker-1');
  });
});
