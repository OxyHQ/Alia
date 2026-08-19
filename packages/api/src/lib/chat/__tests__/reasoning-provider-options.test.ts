import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';
import { EFFORT_LEVELS, type EffortLevel } from '../../reasoning-effort.js';

/**
 * The effort level is actually SENT, under a key the SDK reads.
 *
 * The bug this replaces was not a wrong value. It was a config key nobody
 * reads: `experimental_thinking` and `experimental_providerMetadata` are AI SDK
 * **v4** names, this service runs `ai@6`, and `baseConfig` is typed `any` with
 * an eslint-disable — so the options were written, typechecked, logged
 * ("Enabled Anthropic thinking mode") and discarded, for the entire life of the
 * v6 migration.
 *
 * That failure mode is invisible to every test that asserts on the object this
 * code produces, because the object was correct by its own lights. So this file
 * asserts two different things:
 *
 *  - **the shape**, driven through the real `buildBaseConfig`; and
 *  - **that the key is one the installed SDK actually reads**, against the
 *    packages on disk, with positive controls. Without the second, a future
 *    rename of `providerOptions` reproduces the original bug exactly and every
 *    shape assertion here stays green.
 *
 * The rule the whole feature rests on is the last describe block: a level that
 * is OFFERED must be a level that is SENT. Four labels over a boolean was the
 * interface this replaces, and it promised a reasoning budget nobody
 * transmitted.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));

function resolvedFor(provider: string, publisher: string, model: string): ResolvedModel {
  // A key config is enough to construct a provider client; `getAIModel` makes
  // no network call, so no credential and no fixture server is needed.
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

function build(
  route: { provider: string; publisher: string; model: string },
  reasoningEffort: EffortLevel | null,
  body: Record<string, unknown> = {},
) {
  const { config, clearFirstByteTimer } = buildBaseConfig({
    resolved: resolvedFor(route.provider, route.publisher, route.model),
    body,
    convertedMessages: [],
    truncatedTools: {},
    reasoningEffort,
    systemPromptTokens: 0,
    streamState: { hasStreamedContent: false } as never,
    onUsage: () => {},
  });
  // The builder arms a first-byte timer; leaving it running keeps the process
  // alive past the assertion.
  clearFirstByteTimer();
  return config;
}

const CLAUDE = { provider: 'anthropic', publisher: 'anthropic', model: 'claude-sonnet-4' };
const GEMINI_25 = { provider: 'google', publisher: 'google', model: 'gemini-2.5-flash' };
const GEMINI_3 = { provider: 'google', publisher: 'google', model: 'gemini-3-pro-preview' };
const O1 = { provider: 'openai', publisher: 'openai', model: 'o1' };

describe('Anthropic gets a budget that grows with the level', () => {
  it('sends a thinking budget, under providerOptions', () => {
    expect(build(CLAUDE, 'medium').providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
    });
    expect(build(CLAUDE, 'high').providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    });
    expect(build(CLAUDE, 'max').providerOptions).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 6144 } },
    });
  });

  it('every level sends a DIFFERENT budget', () => {
    // A label whose behaviour equals its neighbour's is a level that is painted
    // and not sent, which is the whole thing this feature must not do.
    const budgets = (['medium', 'high', 'max'] as const).map(
      (level) => JSON.stringify(build(CLAUDE, level).providerOptions),
    );
    expect(new Set(budgets).size).toBe(budgets.length);
  });

  it('leaves room to ANSWER, so the provider\'s sum lands on the model ceiling', () => {
    /**
     * `maxOutputTokens` is the answer room, not the total.
     * `@ai-sdk/anthropic` adds the thinking budget to it, so every level must
     * declare `ceiling - budget` or the request asks for more output than the
     * model allows. The totals are asserted on the real request bytes in
     * `reasoning-on-the-wire.test.ts`; this is the same arithmetic one layer up.
     */
    expect(build(CLAUDE, 'medium').maxOutputTokens).toBe(8192 - 2048);
    expect(build(CLAUDE, 'high').maxOutputTokens).toBe(8192 - 4096);
    expect(build(CLAUDE, 'max').maxOutputTokens).toBe(8192 - 6144);
    // Still room for an answer at the dearest level, which is what stops the
    // budget being raised until replies start truncating.
    expect(build(CLAUDE, 'max').maxOutputTokens).toBeGreaterThan(0);
  });

  it("does not overwrite a caller's own max_tokens", () => {
    expect(build(CLAUDE, 'max', { max_tokens: 7000 }).maxOutputTokens).toBe(7000);
  });

  it('the v4 keys must not come back', () => {
    const config = build(CLAUDE, 'max');
    expect(config.experimental_thinking).toBeUndefined();
    expect(config.experimental_providerMetadata).toBeUndefined();
  });
});

describe('the cheapest level carries no budget — the negative control', () => {
  /**
   * The floor for the whole feature. Every assertion above is satisfied by a
   * builder that attaches a budget unconditionally, which is the defect in the
   * other direction: a person who chose `instant` and is billed for reasoning.
   */
  it('Anthropic is told to stop thinking, explicitly, with no budget', () => {
    const options = build(CLAUDE, 'instant').providerOptions;
    expect(options).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
    // Spelled as a search over the serialized request rather than as a shape
    // assertion, so a budget smuggled into any other field fails too.
    expect(JSON.stringify(options)).not.toContain('budgetTokens');
  });

  it('Gemini 2.5 is given a budget of zero', () => {
    expect(build(GEMINI_25, 'instant').providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: true } },
    });
  });

  it('and asking for nothing at all sends nothing at all', () => {
    // Distinct from `instant`: no level means the model's own default, and an
    // empty `providerOptions` is a different request from one that omits it.
    expect(build(CLAUDE, null).providerOptions).toBeUndefined();
    expect(build(GEMINI_25, null).providerOptions).toBeUndefined();
    expect(build(O1, null).providerOptions).toBeUndefined();
  });
});

describe('Gemini thought summaries are gated on the level — the second defect', () => {
  /**
   * The Google branch was never conditional: every Gemini request asked for
   * thought summaries whether or not the caller wanted reasoning. It was
   * invisible only because the option sat under a key the SDK ignores, so
   * fixing the key alone would have turned it on for everybody at once.
   */
  it('asks for them only when a level was chosen', () => {
    expect(JSON.stringify(build(GEMINI_25, 'high').providerOptions)).toContain('includeThoughts');
    expect(build(GEMINI_25, null).providerOptions).toBeUndefined();
  });

  it('Gemini 3 sends a thinking LEVEL, not Gemini 2.5s budget', () => {
    // Sending `thinkingBudget` here would be shipping the older model's
    // parameter to a newer one because both happen to typecheck.
    expect(build(GEMINI_3, 'max').providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
    });
  });
});

describe('a route that cannot carry the option is sent nothing', () => {
  it('a model that does not reason gets no options, at any level', () => {
    for (const level of EFFORT_LEVELS) {
      expect(
        build({ provider: 'openai', publisher: 'openai', model: 'gpt-4o-mini' }, level).providerOptions,
        level,
      ).toBeUndefined();
    }
  });

  it('a reasoning model served over somebody else\'s endpoint gets no options', () => {
    /**
     * The trap this rule exists for. `claude-sonnet-4.6` reaches users only
     * through DigitalOcean, whose client is `createOpenAI` with a foreign
     * `baseURL` — so `providerOptions.anthropic` would be assembled, serialized
     * and ignored, which is the original bug wearing the correct key.
     */
    for (const level of EFFORT_LEVELS) {
      expect(
        build({ provider: 'digitalocean', publisher: 'anthropic', model: 'claude-sonnet-4' }, level).providerOptions,
        level,
      ).toBeUndefined();
    }
  });

  it('a level the model does not offer is not invented for it', () => {
    // o1 cannot be told to stop reasoning, so it offers no `instant` — and the
    // builder must send nothing rather than reach for the nearest value.
    expect(build(O1, 'instant').providerOptions).toBeUndefined();
    expect(build(O1, 'medium').providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });
});

describe('the option keys are ones the installed SDKs actually read', () => {
  /**
   * Read off the packages on disk rather than trusted from a version number:
   * the question is not "which major is this", it is "does the code that
   * receives this object look at this key".
   */
  const pkg = (name: string): string =>
    readFileSync(path.join(REPO_ROOT, `node_modules/${name}/dist/index.js`), 'utf8');

  it('finds the keys this code uses, and does not find the v4 ones', () => {
    const core = pkg('ai');
    // Positive controls FIRST. A grep that matches nothing reports "the v4 keys
    // are gone" and "the SDK reads providerOptions" with equal confidence, and
    // one of those is the bug.
    expect(core).toContain('stopWhen');
    expect(core).toContain('providerOptions');

    expect(core).not.toContain('experimental_thinking');
    expect(core).not.toContain('experimental_providerMetadata');
  });

  it('each provider package parses the option this code sends it', () => {
    expect(pkg('@ai-sdk/anthropic')).toContain('budgetTokens');
    expect(pkg('@ai-sdk/google')).toContain('thinkingConfig');
    expect(pkg('@ai-sdk/google')).toContain('thinkingLevel');
    expect(pkg('@ai-sdk/openai')).toContain('reasoningEffort');
  });

  it('the source no longer writes an option name the SDK does not read', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages/api/src/lib/chat/model-config.ts'),
      'utf8',
    );
    // Assignments only — the file's own prose explains what went wrong and
    // names both keys, and a census that read the explanation would be
    // permanently red.
    expect(source).not.toMatch(/baseConfig\.experimental_/);
    expect(source).toMatch(/baseConfig\.providerOptions\s*=/);
  });
});
