import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../models/selection.js', () => ({ getUtilityModelId: async () => 'acme/small-1' }));

const mocks = vi.hoisted(() => ({
  request: null as Record<string, unknown> | null,
  options: null as Record<string, unknown> | null,
}));

vi.mock('../oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.request = request;
      mocks.options = options;
      return {
        output: [{ role: 'assistant', content: [{ type: 'text', text: ' resultado ' }] }],
        finishReason: 'stop',
        usage: [],
      };
    },
  }),
}));

import { generateTextViaKaana } from '../kaana-text.js';

describe('one-shot product inference through Oxy', () => {
  beforeEach(() => {
    mocks.request = null;
    mocks.options = null;
  });

  it('sends the named catalogue model', async () => {
    await expect(generateTextViaKaana({
      model: 'acme/big-2',
      prompt: 'resume esto',
      surface: 'background',
      maxOutputTokens: 128,
      oxyUserId: 'user-id',
    })).resolves.toBe('resultado');

    expect(mocks.request).not.toHaveProperty('routingProfile');
    expect(mocks.request).not.toHaveProperty('routingProfileId');
    expect(mocks.request).toMatchObject({
      model: 'acme/big-2',
      labels: { 'alia.surface': 'background', 'alia.visibility': 'derived' },
    });
    expect(mocks.options).toMatchObject({ delegatedUserId: 'user-id' });
  });

  it('carries a structured response request without provider options', async () => {
    const responseFormat = {
      type: 'json_schema' as const,
      name: 'summary',
      schema: { type: 'object' },
      strict: false,
    };
    await generateTextViaKaana({
      prompt: 'resume esto',
      surface: 'authoring',
      maxOutputTokens: 128,
      responseFormat,
    });

    expect(mocks.request?.responseFormat).toEqual(responseFormat);
    // No model named: the utility model the catalogue selects.
    expect(mocks.request?.model).toBe('acme/small-1');
    expect(mocks.request).not.toHaveProperty('providerOptions');
  });
});
