import { NoObjectGeneratedError, type LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';
import { structuredFailureDiagnostics } from './selection-diagnostics.js';

const usage: LanguageModelUsage = {
  inputTokens: 1000,
  inputTokenDetails: {
    noCacheTokens: 1000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 2560,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 2560 },
  totalTokens: 3560,
  raw: { private: 'never serialize raw usage' },
};
const failure = (options: Partial<ConstructorParameters<typeof NoObjectGeneratedError>[0]>) =>
  new NoObjectGeneratedError({
    message: 'private provider error',
    response: {
      id: 'private response id',
      timestamp: new Date(),
      modelId: 'private model id',
      headers: { authorization: 'private credential' },
    },
    usage,
    finishReason: 'length',
    ...options,
  });

describe('safe structured selection evaluation diagnostics', () => {
  it('distinguishes reasoning-only output exhaustion without serializing provider metadata', () => {
    expect(structuredFailureDiagnostics(failure({}), [])).toEqual({
      failureKind: 'no_text',
      finishReason: 'length',
      textPresent: false,
      textLength: 0,
      usage: {
        inputTokens: 1000,
        outputTokens: 2560,
        totalTokens: 3560,
        textTokens: 0,
        reasoningTokens: 2560,
      },
    });
  });

  it.each([
    ['AI_JSONParseError', 'parse'],
    ['AI_TypeValidationError', 'schema'],
    ['private cause name', 'unknown'],
  ])('classifies %s without returning its text or cause message', (name, failureKind) => {
    const cause = new Error('private cause detail');
    cause.name = name;
    const result = structuredFailureDiagnostics(
      failure({ text: 'private generated content', cause, finishReason: 'stop' }),
      [],
    );
    expect(result).toMatchObject({ failureKind, finishReason: 'stop', textPresent: true });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('echoes only known legal choices, not arbitrary strings or other generated fields', () => {
    const legal = 'open-person-request:member-s';
    const known = structuredFailureDiagnostics(
      failure({ text: JSON.stringify({ choice: legal, secret: 'private value' }) }),
      [legal],
    );
    expect(known?.choice).toBe(legal);
    expect(JSON.stringify(known)).not.toContain('private');
    expect(
      structuredFailureDiagnostics(failure({ text: '{"choice":"private value"}' }), [legal]),
    ).not.toHaveProperty('choice');
  });

  it('omits absent or invalid usage instead of inventing token evidence', () => {
    const result = structuredFailureDiagnostics(
      failure({
        usage: {
          ...usage,
          inputTokens: Number.NaN,
          outputTokens: -1,
          totalTokens: Number.POSITIVE_INFINITY,
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      }),
      [],
    );
    expect(JSON.parse(JSON.stringify(result)).usage).toEqual({});
    expect(structuredFailureDiagnostics(new Error('private'), [])).toBeUndefined();
  });
});
