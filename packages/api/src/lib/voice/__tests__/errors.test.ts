import { describe, expect, it } from 'vitest';
import { FakeKaanaError } from '../../kaana/fake.js';
import { upstreamOfFailure, VoiceFailure, voiceFailureFromKaana } from '../errors.js';

describe('upstreamOfFailure', () => {
  it("names Kaana's code, param and request id, so a refusal is readable from the log", () => {
    const refusal = new FakeKaanaError('invalid_request', { param: 'limits.maxTextItems' });
    const failure = voiceFailureFromKaana(refusal);
    expect(failure.code).toBe('realtime-rejected');
    expect(upstreamOfFailure(failure)).toEqual({
      kind: 'kaana',
      code: 'invalid_request',
      param: 'limits.maxTextItems',
      requestId: refusal.requestId,
      status: null,
    });
  });

  it('adds nothing for a failure Alia decided itself', () => {
    expect(upstreamOfFailure(new VoiceFailure('plan-required'))).toBeNull();
  });
});
