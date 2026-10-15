import { OxyInferenceError, OxyInferenceProtocolError } from '@oxy.so/core/inference';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({
  speech: vi.fn(),
  configured: true,
  speechModels: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../models/selection.js', () => ({ getSpeechModelIds: H.speechModels }));
vi.mock('../inference/oxy-inference.js', () => ({
  getOxyInferenceClient: () => (H.configured ? { speech: H.speech } : null),
}));
vi.mock('../logger.js', () => ({ log: { speech: { warn: H.warn } } }));
import {
  MAX_SPEECH_MODEL_ATTEMPTS,
  SpeechSynthesisError,
  synthesizeSpeech,
} from '../synthesize-speech.js';

const request = { input: 'Hola, ¿qué tal?', voice: 'female', format: 'mp3', userId: 'u1' };
const audio = (requestId: string) => ({
  audio: new Uint8Array([73, 68, 51, 255, 0]),
  mediaType: 'audio/mpeg',
  requestId,
});
function refusal(
  code: OxyInferenceError['code'],
  status: number,
  extra: { retryable?: boolean; retryAfterMs?: number; param?: string } = {},
) {
  return new OxyInferenceError({
    code,
    status,
    message: `upstream said ${code}`,
    requestId: `req_${code}`,
    retryable: extra.retryable ?? false,
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    ...(extra.param === undefined ? {} : { param: extra.param }),
  });
}
const modelsCalled = () => H.speech.mock.calls.map((call) => (call[0] as { model: string }).model);

beforeEach(() => {
  H.configured = true;
  H.speech.mockReset();
  H.warn.mockReset();
  H.speechModels.mockReset();
  H.speechModels.mockResolvedValue(['acme/voice-1', 'beta/voice-2', 'gamma/voice-3']);
});

describe('speech through Oxy', () => {
  it('uses the first catalogue speech model and attributes the call to its user', async () => {
    H.speech.mockResolvedValue(audio('req_test'));
    const result = await synthesizeSpeech({ ...request, input: 'Hola', speed: 1.15 });
    expect(result.audio).toEqual(Buffer.from([73, 68, 51, 255, 0]));
    expect(result.requestId).toBe('req_test');
    expect(result.model).toBe('acme/voice-1');
    expect(H.speech).toHaveBeenCalledTimes(1);
    expect(H.speech).toHaveBeenCalledWith(
      {
        model: 'acme/voice-1',
        input: 'Hola',
        voice: 'female',
        response_format: 'mp3',
        speed: 1.15,
      },
      { delegatedUserId: 'u1', signal: expect.any(AbortSignal) },
    );
  });

  it('propagates the caller’s cancellation as is, and tries no other model', async () => {
    const controller = new AbortController();
    controller.abort();
    H.speech.mockImplementation(async (_body, options) => {
      options.signal.throwIfAborted();
    });
    const failure = await synthesizeSpeech({ ...request, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(SpeechSynthesisError);
    expect(H.speech).toHaveBeenCalledTimes(1);
  });

  it('refuses before egress, typed, when no client is configured', async () => {
    H.configured = false;
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      name: 'SpeechSynthesisError',
      code: 'SPEECH_UNAVAILABLE',
      reason: 'not_configured',
      httpStatus: 503,
    });
    expect(H.speech).not.toHaveBeenCalled();
  });

  it('refuses before egress, typed, when the catalogue offers no speech model', async () => {
    H.speechModels.mockRejectedValue(new Error('No speech model is available in the catalogue'));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_UNAVAILABLE',
      reason: 'no_speech_model',
      httpStatus: 503,
    });
    expect(H.speech).not.toHaveBeenCalled();
  });
});

describe('a refusal the model answers for falls back to the next speech model', () => {
  it.each([
    ['invalid_request', 400],
    ['unsupported_modality', 400],
    ['model_not_found', 404],
    ['no_route_available', 503],
    ['commercial_permission_denied', 403],
  ] as const)('%s → the next model answers', async (code, status) => {
    H.speech
      .mockRejectedValueOnce(refusal(code, status, { param: 'voice' }))
      .mockResolvedValueOnce(audio('req_second'));
    const result = await synthesizeSpeech(request);
    expect(result.requestId).toBe('req_second');
    // The model that answered, so its clip is stored under the right key.
    expect(result.model).toBe('beta/voice-2');
    expect(modelsCalled()).toEqual(['acme/voice-1', 'beta/voice-2']);
    // Logged without the text or the user.
    expect(H.warn).toHaveBeenCalledWith(
      {
        model: 'acme/voice-1',
        next: 'beta/voice-2',
        upstreamCode: code,
        upstreamStatus: status,
        requestId: `req_${code}`,
        param: 'voice',
      },
      expect.any(String),
    );
    expect(JSON.stringify(H.warn.mock.calls)).not.toContain(request.input);
    expect(JSON.stringify(H.warn.mock.calls)).not.toContain('u1');
  });

  it('fails typed with every model tried when they all refuse', async () => {
    H.speech
      .mockRejectedValueOnce(refusal('invalid_request', 400, { param: 'speed' }))
      .mockRejectedValueOnce(refusal('no_route_available', 503))
      .mockRejectedValueOnce(refusal('invalid_request', 400, { param: 'voice' }));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_REJECTED',
      reason: 'refused',
      httpStatus: 422,
      upstreamCode: 'invalid_request',
      upstreamStatus: 400,
      requestId: 'req_invalid_request',
      param: 'voice',
      models: ['acme/voice-1', 'beta/voice-2', 'gamma/voice-3'],
    });
  });

  it(`tries at most ${MAX_SPEECH_MODEL_ATTEMPTS} models`, async () => {
    H.speechModels.mockResolvedValue(['a/1', 'b/2', 'c/3', 'd/4', 'e/5']);
    H.speech.mockRejectedValue(refusal('model_not_found', 404));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_UNAVAILABLE',
      models: ['a/1', 'b/2', 'c/3'],
    });
    expect(H.speech).toHaveBeenCalledTimes(MAX_SPEECH_MODEL_ATTEMPTS);
  });
});

describe('a refusal that is not the model’s is never retried on another', () => {
  it.each([
    ['authentication_failed', 401, 'SPEECH_UNAVAILABLE', 503],
    ['permission_denied', 403, 'SPEECH_UNAVAILABLE', 503],
    ['insufficient_scope', 403, 'SPEECH_UNAVAILABLE', 503],
    ['insufficient_balance', 402, 'SPEECH_LIMIT_REACHED', 429],
    ['spending_limit_exceeded', 402, 'SPEECH_LIMIT_REACHED', 429],
    ['quota_exceeded', 429, 'SPEECH_LIMIT_REACHED', 429],
    ['provider_credential_invalid', 502, 'SPEECH_PROVIDER_FAILED', 502],
    ['provider_billing_refused', 502, 'SPEECH_PROVIDER_FAILED', 502],
    ['policy_violation', 400, 'SPEECH_REJECTED', 422],
    ['upstream_content_filtered', 400, 'SPEECH_REJECTED', 422],
    ['provider_error', 502, 'SPEECH_PROVIDER_FAILED', 502],
    ['internal_error', 500, 'SPEECH_PROVIDER_FAILED', 502],
  ] as const)('%s → %s', async (upstream, status, code, httpStatus) => {
    H.speech.mockRejectedValue(refusal(upstream, status));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code,
      httpStatus,
      upstreamCode: upstream,
      upstreamStatus: status,
      requestId: `req_${upstream}`,
      models: ['acme/voice-1'],
    });
    expect(H.speech).toHaveBeenCalledTimes(1);
    expect(H.warn).not.toHaveBeenCalled();
  });

  it('keeps a retryable refusal’s wait for the client, without retrying it here', async () => {
    H.speech.mockRejectedValue(
      refusal('rate_limited', 429, { retryable: true, retryAfterMs: 1500 }),
    );
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_LIMIT_REACHED',
      retryable: true,
      retryAfterMs: 1500,
    });
    H.speech.mockReset();
    H.speech.mockRejectedValue(refusal('service_unavailable', 503, { retryable: true }));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_UNAVAILABLE',
      retryable: true,
    });
    expect(H.speech).toHaveBeenCalledTimes(1);
  });
});

describe('failures that are not a refusal', () => {
  it('a transport or protocol failure is the provider’s, typed, and not retried', async () => {
    H.speech.mockRejectedValue(new OxyInferenceProtocolError('empty audio', 'req_proto'));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_FAILED',
      reason: 'transport',
      requestId: 'req_proto',
      httpStatus: 502,
    });
    H.speech.mockReset();
    H.speech.mockRejectedValue(new TypeError('fetch failed'));
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_FAILED',
      reason: 'transport',
    });
    expect(H.speech).toHaveBeenCalledTimes(1);
  });

  it('audio that is not MP3 is the provider’s failure', async () => {
    H.speech.mockResolvedValue({ ...audio('req_wav'), mediaType: 'audio/wav' });
    await expect(synthesizeSpeech(request)).rejects.toMatchObject({
      code: 'SPEECH_PROVIDER_FAILED',
      reason: 'unexpected_format',
      requestId: 'req_wav',
    });
  });

  it('running out of time is a timeout, typed as the provider’s, answered 504', async () => {
    // The request's own budget, expired by hand: fake timers do not drive `AbortSignal.timeout`.
    const budget = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
    try {
      H.speech.mockImplementation(async (_body, options: { signal: AbortSignal }) => {
        budget.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        options.signal.throwIfAborted();
      });
      await expect(synthesizeSpeech(request)).rejects.toMatchObject({
        code: 'SPEECH_PROVIDER_FAILED',
        reason: 'timeout',
        httpStatus: 504,
        models: ['acme/voice-1'],
      });
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
