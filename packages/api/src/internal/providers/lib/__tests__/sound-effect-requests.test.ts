/**
 * What a sound-effect call actually PUTS ON THE WIRE, per provider.
 *
 * `synthesize-sound-effect.ts` sends one provider-neutral body — `{ prompt,
 * duration_seconds }` — to `/v1/sound-generation`, and the two routes in the
 * `v1-sfx` tier want almost nothing in common: ElevenLabs takes `text` and
 * `duration_seconds` at a URL with no voice in it, fal takes `prompt` and
 * `seconds_total` through async-invoke. The translation is the whole seam, and a
 * test that stubbed `callProviderAPI` would never touch it: the loop above would
 * be green while every request left here malformed.
 *
 * ## The failure this is written against
 *
 * `buildAsyncInvokeInput` ends in a catch-all that forwards the body verbatim
 * for any model id containing "audio", and `fal-ai/stable-audio-25/text-to-audio`
 * contains it. So without an explicit branch the request SUCCEEDS carrying a
 * `duration_seconds` fal does not read, and returns a clip of the default
 * length — a wrong answer with a 200 on it, which is the shape nobody
 * investigates.
 *
 * ## Why it lives inside `internal/providers/`
 *
 * Gate 1 in `__tests__/architectureGates.test.ts` freezes the (importer →
 * provider tree) pairs by exact count. A test importing `provider-api` from
 * `lib/__tests__/` would have to widen that inventory, and a test is a bad
 * reason to widen it — `credential-redaction.test.ts` is here for the same
 * reason.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../key-manager.js', () => ({
  getBestKeyForModel: async () => ({ keyId: 'key-1', key: 'xi-test-key' }),
  recordKeySuccess: async () => {},
  recordKeyFailure: async () => {},
  recordKeyUsage: async () => {},
  markKeyCreditExhausted: async () => {},
}));

/** Captures the async-invoke input fal would have been handed. */
const asyncInvoke = vi.fn(async (_options: { input: Record<string, unknown> }) => ({
  output: { url: 'https://example.invalid/effect.mp3' },
}));
const downloadBinaryFromUrl = vi.fn(async () => Buffer.from('fal-mp3-bytes'));
vi.mock('../digitalocean-async.js', () => ({
  callDigitalOceanAsyncInvoke: (options: { input: Record<string, unknown> }) => asyncInvoke(options),
  downloadBinaryFromUrl: () => downloadBinaryFromUrl(),
  extractAudioUrl: (output: { output?: { url?: string } }) => output?.output?.url ?? null,
}));

import { callProviderAPI } from '../provider-api.js';

const SFX_ENDPOINT = '/v1/sound-generation';
const PROMPT = 'smooth transition whoosh, 2 seconds';

/** Every `fetch` this suite makes, as `[url, parsedBody]`. */
const fetched: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  fetched.length = 0;
  asyncInvoke.mockClear();
  downloadBinaryFromUrl.mockClear();
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    fetched.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  });
});

describe('ElevenLabs serves two endpoints and they share only the key', () => {
  it('asks the sound endpoint for a sound, with no voice anywhere in the request', async () => {
    await callProviderAPI<Buffer>({
      provider: 'elevenlabs',
      modelId: 'eleven_text_to_sound_v2',
      endpoint: SFX_ENDPOINT,
      body: { prompt: PROMPT, duration_seconds: 5 },
      responseType: 'arrayBuffer',
      maxAttempts: 1,
    });

    expect(fetched).toHaveLength(1);
    const call = fetched[0];
    /**
     * The PATH, and the host deliberately unnamed: gate 2 in
     * `__tests__/architectureGates.test.ts` freezes every provider hostname to
     * the files allowed to say it, and "no provider hostname appears in any
     * test file" is a property that gate MEASURES rather than assumes. The
     * routing decision under test is which path and which body, not which host
     * — `provider-api.ts` owns that and is where the gate keeps it.
     */
    expect(new URL(call?.url ?? '').pathname).toBe('/v1/sound-generation');
    // No query string: `output_format` belongs to the speech endpoint only.
    expect(new URL(call?.url ?? '').search).toBe('');
    /**
     * Named in full rather than checked field by field. The failure this
     * forbids is a `voice` or an `output_format` surviving from the speech
     * shape — extra fields the sound endpoint rejects — and a subset check
     * cannot see one.
     */
    expect(call?.body).toEqual({
      text: PROMPT,
      duration_seconds: 5,
      model_id: 'eleven_text_to_sound_v2',
    });
  });

  /**
   * The positive control, and the assertion that makes the one above mean
   * something. Both requests go through one function now; if it stopped
   * branching and sent every call to the sound endpoint, the test above would
   * still pass and every spoken line in every episode would be a 422.
   */
  it('still speaks through the voice endpoint, with the voice in the PATH', async () => {
    await callProviderAPI<Buffer>({
      provider: 'elevenlabs',
      modelId: 'eleven_multilingual_v2',
      endpoint: '/v1/audio/speech',
      body: { input: 'Buenas tardes.', voice: 'voice-abc' },
      responseType: 'arrayBuffer',
      maxAttempts: 1,
    });

    const call = fetched[0];
    expect(new URL(call?.url ?? '').pathname).toBe('/v1/text-to-speech/voice-abc');
    expect(new URL(call?.url ?? '').search).toBe('?output_format=mp3_44100_128');
    expect(call?.body).toEqual({ text: 'Buenas tardes.', model_id: 'eleven_multilingual_v2' });
  });

  it('names the model it is billed for rather than letting the API default', async () => {
    // MEASURED 2026-08-25: the sound endpoint answers 422 for any id outside
    // `eleven_text_to_sound_v2` / `eleven_text_to_sound_v3`, so an omitted
    // `model_id` is the one case where the router's logs, its usage record and
    // the key failure it attributes could all name a model that never served.
    await callProviderAPI<Buffer>({
      provider: 'elevenlabs',
      modelId: 'eleven_text_to_sound_v3',
      endpoint: SFX_ENDPOINT,
      body: { prompt: PROMPT, duration_seconds: 5 },
      responseType: 'arrayBuffer',
      maxAttempts: 1,
    });

    expect(fetched[0]?.body.model_id).toBe('eleven_text_to_sound_v3');
  });
});

describe('the fal route takes the same neutral body and spells its length differently', () => {
  it('translates duration_seconds into seconds_total, and forwards neither name twice', async () => {
    const audio = await callProviderAPI<Buffer>({
      provider: 'digitalocean',
      modelId: 'fal-ai/stable-audio-25/text-to-audio',
      endpoint: SFX_ENDPOINT,
      body: { prompt: PROMPT, duration_seconds: 5 },
      responseType: 'arrayBuffer',
      maxAttempts: 1,
    });

    // No HTTP call of its own: async-invoke is the transport for this provider.
    expect(fetched).toHaveLength(0);
    expect(asyncInvoke).toHaveBeenCalledTimes(1);

    /**
     * Exact, for the reason above: `duration_seconds` reaching fal is a request
     * that works and returns the WRONG LENGTH, which no status code reports.
     */
    expect(asyncInvoke.mock.calls[0]?.[0].input).toEqual({ prompt: PROMPT, seconds_total: 5 });
    expect(audio.toString()).toBe('fal-mp3-bytes');
  });
});
