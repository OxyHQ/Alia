import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import { EFFORT_LEVELS, type EffortLevel } from '../../reasoning-effort.js';

/**
 * The budget is in the HTTP REQUEST, not merely in an object we built.
 *
 * ## Why this exists beside `reasoning-provider-options.test.ts`
 *
 * That file asserts the shape `buildBaseConfig` produces, and greps the
 * installed packages for the key names. Both were true of the code this
 * replaces as well — `experimental_thinking` was a real key, spelled
 * consistently, on an object that was correct by its own lights. It was simply
 * never READ. Every assertion made on our side of the boundary is blind to
 * exactly that failure, which is the one that actually shipped and survived a
 * whole major-version migration.
 *
 * So this drives the REAL provider client, through the real `generateText`, and
 * reads the bytes it tries to send. A key the SDK ignores does not appear in
 * the body, and that is a difference no amount of shape assertion can see.
 *
 * The transport is a stubbed `fetch`. No network, no credential: the provider
 * serialises the request before it can discover the response is a fixture, and
 * the body is captured on the way past.
 */

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A minimal well-formed reply per CLIENT FAMILY, so `generateText` resolves.
 *
 * Keyed by the client `lib/chat-core.ts` builds rather than by the provider
 * name, because that is what decides the wire format: every provider outside
 * the three first-party ones is `createOpenAI` with a different `baseURL`, so
 * DigitalOcean speaks OpenAI's dialect and needs OpenAI's reply.
 */
const RESPONSES: Readonly<Record<string, unknown>> = {
  anthropic: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    id: 'chatcmpl-1',
    // No `object` field: the provider's parser does not require one, and the
    // literal would put this file into gate 5's census of modules that EMIT an
    // object kind (`__tests__/architectureGates.test.ts`) — which is a census
    // of what Alia serializes, not of what a stubbed upstream replies.
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  google: {
    candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  },
};

function resolvedFor(provider: string, publisher: string, model: string): ResolvedModel {
  return {
    aliasModelId: 'alia-v1-pro-max',
    provider,
    publisher,
    model,
    modelId: 'test-model',
    keyConfig: { provider, modelId: 'test-model', key: 'test-key' },
    aliaModel: { id: 'alia-v1-pro-max' },
    isFallback: false,
    fallbackIndex: 0,
  } as unknown as ResolvedModel;
}

/** Run one turn and hand back what the provider tried to POST. */
async function sent(
  route: { provider: string; publisher: string; model: string },
  reasoningEffort: EffortLevel | null,
): Promise<Captured> {
  const captured: Captured[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    captured.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
    const family = Object.hasOwn(RESPONSES, route.provider) ? route.provider : 'openai';
    return new Response(JSON.stringify(RESPONSES[family]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

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

  // `tools: {}` upsets some providers' schema validation and is irrelevant here.
  const { tools: _tools, ...rest } = config as Record<string, unknown>;
  await generateText(rest as Parameters<typeof generateText>[0]);

  // Floor: a request that never left would make every assertion below vacuous.
  expect(captured.length, 'the provider sent no request at all').toBeGreaterThan(0);
  return captured[0];
}

const CLAUDE = { provider: 'anthropic', publisher: 'anthropic', model: 'claude-sonnet-4' };
const GEMINI_25 = { provider: 'google', publisher: 'google', model: 'gemini-2.5-flash' };
const GEMINI_3 = { provider: 'google', publisher: 'google', model: 'gemini-3-pro-preview' };
const O1 = { provider: 'openai', publisher: 'openai', model: 'o1' };
const PLAIN = { provider: 'openai', publisher: 'openai', model: 'gpt-4o-mini' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the capture itself works, so an absent field means absence', () => {
  it('sees a field the request definitely carries', async () => {
    // The positive control for every `not.toContain` below. Without it, a
    // capture that recorded an empty object would report "no budget was sent"
    // for the same reason it reports "the messages were sent".
    const { body, url } = await sent(CLAUDE, 'max');
    expect(url).toContain('anthropic');
    expect(JSON.stringify(body)).toContain('hello');
  });
});

describe('each level puts its own budget on the wire', () => {
  it('Anthropic gets thinking enabled, with the level\'s budget', async () => {
    const medium = await sent(CLAUDE, 'medium');
    expect(medium.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });

    const high = await sent(CLAUDE, 'high');
    expect(high.body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });

    const max = await sent(CLAUDE, 'max');
    expect(max.body.thinking).toEqual({ type: 'enabled', budget_tokens: 6144 });

    /**
     * And the total lands exactly on the model's 8192 output ceiling, rather
     * than above it.
     *
     * `@ai-sdk/anthropic` computes `max_tokens = maxOutputTokens + budget`, so
     * this is the assertion that catches passing the ceiling itself: that would
     * ask for 14336 on a model that caps at 8192, and Anthropic refuses it.
     * Every level has to land on the same total, which is what makes the
     * remainder arithmetic visible rather than incidental.
     */
    expect(max.body.max_tokens).toBe(8192);
    expect(medium.body.max_tokens).toBe(8192);
    expect(high.body.max_tokens).toBe(8192);
  });

  it('OpenAI gets a reasoning effort', async () => {
    expect((await sent(O1, 'medium')).body.reasoning_effort).toBe('low');
    expect((await sent(O1, 'high')).body.reasoning_effort).toBe('medium');
    expect((await sent(O1, 'max')).body.reasoning_effort).toBe('high');
  });

  it('Google gets a thinking config', async () => {
    const gen25 = (await sent(GEMINI_25, 'high')).body.generationConfig as Record<string, unknown>;
    expect(gen25.thinkingConfig).toEqual({ thinkingBudget: 4096, includeThoughts: true });

    // Gemini 3 takes a level rather than 2.5's budget.
    const gen3 = (await sent(GEMINI_3, 'max')).body.generationConfig as Record<string, unknown>;
    expect(gen3.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true });
  });
});

describe('the negative control: the cheapest level buys no thinking', () => {
  it('Anthropic is told to stop, and no budget is transmitted', async () => {
    const { body } = await sent(CLAUDE, 'instant');
    expect(body.thinking).toEqual({ type: 'disabled' });
    // Over the WHOLE serialized body, so a budget smuggled into any other
    // field fails too — this is the assertion the feature's honesty rests on.
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  it('Gemini is given a budget of zero', async () => {
    const { body } = await sent(GEMINI_25, 'instant');
    const gen = body.generationConfig as Record<string, unknown>;
    expect(gen.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: true });
  });

  it('asking for nothing transmits nothing about thinking', async () => {
    const claude = JSON.stringify((await sent(CLAUDE, null)).body);
    expect(claude).not.toContain('thinking');
    expect(claude).not.toContain('budget_tokens');

    const gemini = JSON.stringify((await sent(GEMINI_25, null)).body);
    expect(gemini).not.toContain('thinking');

    const openai = JSON.stringify((await sent(O1, null)).body);
    expect(openai).not.toContain('reasoning_effort');
  });

  it('a model that does not reason is sent nothing, at every level', async () => {
    for (const level of EFFORT_LEVELS) {
      const body = JSON.stringify((await sent(PLAIN, level)).body);
      expect(body, level).not.toContain('reasoning_effort');
      expect(body, level).not.toContain('thinking');
    }
  });

  it('a reasoning model resold by another operator is sent nothing', async () => {
    // The trap the whole gate exists for: `providerOptions.anthropic` on a
    // DigitalOcean route would be assembled, serialized and ignored — the
    // original bug wearing the correct key.
    const resold = { provider: 'digitalocean', publisher: 'anthropic', model: 'claude-sonnet-4' };
    const body = JSON.stringify((await sent(resold, 'max')).body);
    expect(body).not.toContain('thinking');
    expect(body).not.toContain('budget_tokens');
  });
});
