import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildBaseConfig } from '../model-config.js';
import type { ResolvedModel } from '../../chat-core.js';

/**
 * Extended reasoning is actually SENT, under a key the SDK reads.
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
 *    package on disk, with positive controls. Without the second, a future
 *    rename of `providerOptions` reproduces the original bug exactly and every
 *    shape assertion here stays green.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));

function resolvedFor(provider: string): ResolvedModel {
  // A key config is enough to construct a provider client; `getAIModel` makes
  // no network call, so no credential and no fixture server is needed.
  return {
    aliasModelId: 'alia-v1-pro',
    provider,
    modelId: provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gemini-2.5-flash',
    keyConfig: { provider, modelId: 'test-model', key: 'test-key' },
    aliaModel: { id: 'alia-v1-pro' },
    isFallback: false,
    fallbackIndex: 0,
  } as unknown as ResolvedModel;
}

function build(provider: string, thinkingMode: boolean | undefined) {
  const { config, clearFirstByteTimer } = buildBaseConfig({
    resolved: resolvedFor(provider),
    body: {},
    convertedMessages: [],
    truncatedTools: {},
    thinkingMode,
    systemPromptTokens: 0,
    streamState: { hasStreamedContent: false } as never,
    onUsage: () => {},
  });
  // The builder arms a first-byte timer; leaving it running keeps the process
  // alive past the assertion.
  clearFirstByteTimer();
  return config;
}

describe('the reasoning options go under the key the SDK reads', () => {
  it('sends Anthropic a thinking budget when the caller asked for reasoning', () => {
    const config = build('anthropic', true);

    expect(config.providerOptions?.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2048 },
    });

    // Anthropic refuses a budget that is not strictly below `max_tokens`, and
    // the caller did not send one — so the builder must supply it or the
    // request 400s the moment thinking is switched on.
    expect(config.maxTokens).toBeGreaterThan(2048);

    // The v4 keys must not come back. This is the regression, spelled out.
    expect(config.experimental_thinking).toBeUndefined();
    expect(config.experimental_providerMetadata).toBeUndefined();
  });

  it('gates Gemini thought summaries on the flag, which is the second defect', () => {
    /**
     * The Google branch was never conditional: every Gemini request asked for
     * thought summaries whether or not the caller wanted reasoning. It was
     * invisible only because the option sat under a key the SDK ignores, so
     * fixing the key alone would have turned it on for everybody at once.
     */
    expect(build('google', true).providerOptions?.google).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
    expect(build('google', false).providerOptions).toBeUndefined();
    expect(build('google', undefined).providerOptions).toBeUndefined();
  });

  it('adds nothing at all when reasoning was not asked for', () => {
    // The floor. Every assertion above is satisfied by a builder that attaches
    // `providerOptions` unconditionally, which is the defect in the other
    // direction.
    expect(build('anthropic', false).providerOptions).toBeUndefined();
    expect(build('openai', true).providerOptions).toBeUndefined();
  });
});

describe('the option key is one the installed SDK actually reads', () => {
  /**
   * Read off the package on disk rather than trusted from a version number: the
   * question is not "which major is this", it is "does the code that receives
   * this object look at this key".
   */
  const sdk = readFileSync(path.join(REPO_ROOT, 'node_modules/ai/dist/index.js'), 'utf8');

  it('finds the keys this code uses, and does not find the v4 ones', () => {
    // Positive controls FIRST. A grep that matches nothing reports "the v4 keys
    // are gone" and "the SDK reads providerOptions" with equal confidence, and
    // one of those is the bug.
    expect(sdk).toContain('stopWhen');
    expect(sdk).toContain('providerOptions');

    expect(sdk).not.toContain('experimental_thinking');
    expect(sdk).not.toContain('experimental_providerMetadata');
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
