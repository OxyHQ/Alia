import { describe, expect, it } from 'vitest';
import { KaanaConnectionError, KaanaInvalidRequestError } from '@kaana.ai/sdk';
import { upstreamOfFailure, VoiceFailure, voiceFailureFromKaana } from '../errors.js';

describe('upstreamOfFailure', () => {
  it("names Kaana's code, param and request id, so a refusal is readable from the log", () => {
    const refusal = new KaanaInvalidRequestError({
      code: 'invalid_request',
      message: 'refused',
      status: 400,
      requestId: 'req_123',
      retryable: false,
      param: 'config.voice',
    });
    const failure = voiceFailureFromKaana(refusal);
    expect(failure.code).toBe('realtime-rejected');
    expect(upstreamOfFailure(failure)).toEqual({
      kind: 'kaana',
      code: 'invalid_request',
      param: 'config.voice',
      requestId: refusal.requestId,
      status: 400,
    });
  });

  it('names a lost connection by its kind', () => {
    const failure = voiceFailureFromKaana(new KaanaConnectionError('gone'));
    expect(failure.code).toBe('realtime-failed');
    expect(upstreamOfFailure(failure)).toEqual({ kind: 'connection' });
  });

  it('adds nothing for a failure Alia decided itself', () => {
    expect(upstreamOfFailure(new VoiceFailure('plan-required'))).toBeNull();
  });
});
