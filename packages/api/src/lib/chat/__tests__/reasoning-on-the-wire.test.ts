import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import type { EffortLevel } from '../../reasoning-effort.js';

/**
 * Reasoning configuration crosses Alia's only hosted inference boundary.
 * Provider-specific translation belongs to Kaana, so this suite captures the
 * normalized call handed to the Kaana client and proves that no provider
 * credential, endpoint or wire dialect escapes with it.
 */

const H = vi.hoisted(() => ({
  calls: [] as Array<{
    context: Record<string, unknown>;
    payload: Record<string, unknown>;
  }>,
}));

vi.mock('../../inference/kaana.js', () => ({
  getKaanaClient: () => ({
    generate: async (call: {
      context: Record<string, unknown>;
      payload: Record<string, unknown>;
    }) => {
      H.calls.push(call);
      return {
        outputText: 'ok',
        reasoningText: '',
        refusalText: '',
        finishReason: 'stop',
        usage: [
          { unit: 'input_tokens', quantity: 1 },
          { unit: 'output_tokens', quantity: 1 },
        ],
        toolCalls: [],
      };
    },
  }),
}));

function resolvedFor(provider: string, publisher: string, model: string): ResolvedModel {
  return {
    routingProfileId: 'kaana-v1-pro-max',
    provider,
    publisher,
    model,
    modelId: 'test-model',
    keyConfig: { provider, modelId: 'test-model', key: 'test-key' },
    kaanaReference: `${publisher}/${model}`,
    routingProfile: { id: 'kaana-v1-pro-max' },
    isFallback: false,
    fallbackIndex: 0,
  } as unknown as ResolvedModel;
}

async function sent(
  route: { provider: string; publisher: string; model: string },
  reasoningEffort: EffortLevel | null,
) {
  const { config, clearFirstByteTimer } = buildBaseConfig({
    resolved: resolvedFor(route.provider, route.publisher, route.model),
    body: {},
    convertedMessages: [{ role: 'user', content: 'hello' }],
    truncatedTools: {},
    reasoningEffort,
    systemPromptTokens: 0,
    streamState: { hasStreamedContent: false } as never,
    onUsage: () => {},
  });
  clearFirstByteTimer();

  const { tools: _tools, ...request } = config as Record<string, unknown>;
  await generateText(request as Parameters<typeof generateText>[0]);

  expect(H.calls).toHaveLength(1);
  const call = H.calls[0];
  if (call === undefined) throw new Error('Kaana received no request');
  return call;
}

const CLAUDE = { provider: 'anthropic', publisher: 'anthropic', model: 'claude-sonnet-4' };
const GEMINI = { provider: 'google', publisher: 'google', model: 'gemini-2.5-flash' };
const O1 = { provider: 'openai', publisher: 'openai', model: 'o1' };

beforeEach(() => {
  H.calls.length = 0;
});

describe('reasoning crosses the Kaana-only wire', () => {
  it('captures the message and public API format', async () => {
    const call = await sent(CLAUDE, 'max');
    expect(JSON.stringify(call.payload)).toContain('hello');
    expect(call.payload.client).toEqual({
      apiFormat: 'chat_completions',
      endpoint: '/v1/chat/completions',
    });
  });

  it('uses kaanaReference as the product model target', async () => {
    const call = await sent(CLAUDE, 'medium');
    expect(call.context.model).toEqual({
      kind: 'user_selected',
      productModelId: 'anthropic/claude-sonnet-4',
    });
  });

  it('sends no provider credential or deployment id', async () => {
    const wire = JSON.stringify(await sent(CLAUDE, 'high'));
    expect(wire).not.toContain('test-key');
    expect(wire).not.toContain('test-model');
  });

  it('leaves Anthropic wire translation to Kaana', async () => {
    const wire = JSON.stringify((await sent(CLAUDE, 'max')).payload);
    expect(wire).not.toContain('providerOptions');
    expect(wire).not.toContain('budgetTokens');
    expect(wire).not.toContain('budget_tokens');
  });

  it('leaves OpenAI wire translation to Kaana', async () => {
    const wire = JSON.stringify((await sent(O1, 'max')).payload);
    expect(wire).not.toContain('reasoningEffort');
    expect(wire).not.toContain('reasoning_effort');
  });

  it('leaves Google wire translation to Kaana', async () => {
    const wire = JSON.stringify((await sent(GEMINI, 'max')).payload);
    expect(wire).not.toContain('thinkingConfig');
    expect(wire).not.toContain('thinkingBudget');
  });

  it('adds no provider hint for instant reasoning', async () => {
    const wire = JSON.stringify((await sent(CLAUDE, 'instant')).payload);
    expect(wire).not.toContain('anthropic');
    expect(wire).not.toContain('thinking');
  });

  it('adds no provider hint when no effort was requested', async () => {
    const wire = JSON.stringify((await sent(GEMINI, null)).payload);
    expect(wire).not.toContain('google');
    expect(wire).not.toContain('thinking');
  });

  it('does not expose the retired operator when publisher and operator differ', async () => {
    const resold = {
      provider: 'digitalocean',
      publisher: 'anthropic',
      model: 'claude-sonnet-4',
    };
    const call = await sent(resold, 'max');
    expect(call.context.model).toEqual({
      kind: 'user_selected',
      productModelId: 'anthropic/claude-sonnet-4',
    });
    expect(JSON.stringify(call)).not.toContain('digitalocean');
  });
});
