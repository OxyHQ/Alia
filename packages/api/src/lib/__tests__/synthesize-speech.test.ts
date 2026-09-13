import { beforeEach, describe, expect, it, vi } from 'vitest';
const H = vi.hoisted(() => ({ speech: vi.fn(), configured: true }));
vi.mock('../inference/oxy-inference.js', () => ({ getOxyInferenceClient: () => H.configured ? { speech: H.speech } : null }));
import { synthesizeSpeech } from '../synthesize-speech.js';
import { OXY_KAANA_SPEECH_ROUTING_PROFILE_ID } from '../../config/oxy-inference-routing-profile-ids.js';
beforeEach(() => { H.configured = true; H.speech.mockReset(); });
describe('speech through Oxy', () => {
  it('uses the reviewed opaque profile and attributes the call to its user', async () => {
    H.speech.mockResolvedValue({ audio: new Uint8Array([73,68,51,255,0]), mediaType: 'audio/mpeg', requestId: 'req_test' });
    const result = await synthesizeSpeech({ input: 'Hola', voice: 'female', format: 'mp3', speed: 1.15, userId: 'u1' });
    expect(result.audio).toEqual(Buffer.from([73,68,51,255,0]));
    expect(result.requestId).toBe('req_test');
    expect(H.speech).toHaveBeenCalledWith({ routingProfileId: OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
      input: 'Hola', voice: 'female', response_format: 'mp3', speed: 1.15 }, { delegatedUserId: 'u1', signal: expect.any(AbortSignal) });
  });
  it('propagates cancellation and refuses unavailable configuration before egress', async () => {
    const controller = new AbortController(); controller.abort();
    H.speech.mockImplementation(async (_body, options) => { options.signal.throwIfAborted(); });
    await expect(synthesizeSpeech({ input: 'Hola', voice: 'female', format: 'mp3', userId: 'u1', signal: controller.signal })).rejects.toThrow();
    H.speech.mockClear(); H.configured = false;
    await expect(synthesizeSpeech({ input: 'Hola', voice: 'female', format: 'mp3', userId: 'u1' })).rejects.toMatchObject({ code: 'KAANA_CAPABILITY_UNAVAILABLE' });
    expect(H.speech).not.toHaveBeenCalled();
  });
  it('does not retry a provider refusal', async () => {
    const failure = new Error('provider unavailable'); H.speech.mockRejectedValue(failure);
    await expect(synthesizeSpeech({ input: 'Hola', voice: 'female', format: 'mp3', userId: 'u1' })).rejects.toBe(failure);
    expect(H.speech).toHaveBeenCalledTimes(1);
  });
});
