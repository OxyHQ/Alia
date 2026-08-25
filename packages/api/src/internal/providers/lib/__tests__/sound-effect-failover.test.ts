/**
 * A sound effect survives one provider being unreachable — which is the whole
 * bug, and what the code this replaces could not do at any price.
 *
 * `show-pipeline.ts` named `digitalocean` / `fal-ai/stable-audio-25/text-to-audio`
 * inline as its ONLY route. There was no tier, no second mapping and no loop, so
 * the chain was exhausted on the first attempt every time and the failure was
 * permanent rather than transient. MEASURED in production 2026-08-24 and
 * 2026-08-25: three `no_credential` failures per episode — one per sound cue —
 * against a provider `provider_keys` holds no row for, on episodes that
 * published, reported success and charged their owner.
 *
 * ## Why this file lives inside `internal/providers/`
 *
 * Gate 1 in `__tests__/architectureGates.test.ts` freezes the (importer →
 * provider tree) pairs by exact count, and this file reads the SHIPPED `v1-sfx`
 * chain rather than a fixture — the assertion that the loop is wired to a real
 * chain is the one a fixture cannot make. `audio-tags.test.ts` asks the same
 * question from `lib/__tests__/` and pays for it with an allowlist line; the
 * list is a migration inventory whose direction of travel is DOWN, and
 * `credential-redaction.test.ts` already establishes that a test belongs inside
 * the tree rather than in that inventory. Files here are skipped by the census
 * for the same reason the adapters are.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { synthesizeSoundEffect } from '../../../../lib/synthesize-sound-effect.js';
import { callProviderAPI, getModelMappingsForTier } from '../../../../lib/gateway-client.js';
import { GENERATED_TIER_MAPPINGS } from '../generate-model-mappings.js';
import type { ModelMapping } from '../../../../lib/gateway-client.js';

vi.mock('../../../../lib/gateway-client.js', () => ({
  getModelMappingsForTier: vi.fn(),
  callProviderAPI: vi.fn(),
  getProviderTimeout: vi.fn(() => 15_000),
}));

const PROMPT = 'upbeat show intro jingle, 4 seconds';
const AUDIO = Buffer.from('fake-mp3-bytes');

/** The SHIPPED chain, in the shape the seam hands it over. */
const LIVE_CHAIN: ModelMapping[] = GENERATED_TIER_MAPPINGS['v1-sfx'].map((mapping) => ({
  provider: mapping.provider,
  modelId: mapping.modelId,
  priority: mapping.priority,
  qualityScore: mapping.qualityScore,
  pricingTier: mapping.pricingTier,
  capabilities: { ...mapping.capabilities },
}));

/** `[provider, modelId]` per call, in call order. */
function routed(): Array<[string, string]> {
  return vi.mocked(callProviderAPI).mock.calls.map(([options]) => [options.provider, options.modelId]);
}

beforeEach(() => {
  vi.mocked(getModelMappingsForTier).mockReset();
  vi.mocked(callProviderAPI).mockReset();
  vi.mocked(callProviderAPI).mockResolvedValue(AUDIO);
  vi.mocked(getModelMappingsForTier).mockResolvedValue(LIVE_CHAIN);
});

describe('the chain the process actually resolves', () => {
  /**
   * The floor, and the fix stated as an assertion.
   *
   * Every failover test below passes with a one-entry chain — there is simply
   * nothing to fail over to — and a one-entry chain is exactly the state that
   * lost every sound cue. So the length is asserted before anything else.
   *
   * The two counts are DIFFERENT claims and both are load-bearing. A chain of
   * three mappings on one provider survives a model fault and dies with a
   * credential; only a second PROVIDER covers the failure that actually
   * happened here. The tier's own comment records that production holds a key
   * for exactly one of these providers today, so the second count is a
   * structural guarantee rather than a live one — which is why it is asserted
   * here and stated there rather than implied by the shape.
   */
  it('offers more than one mapping AND more than one provider', () => {
    expect(LIVE_CHAIN.length).toBeGreaterThanOrEqual(2);
    expect(new Set(LIVE_CHAIN.map((m) => m.provider)).size).toBeGreaterThanOrEqual(2);
  });

  /**
   * NAMED, not positional. `chain[0]` would be satisfied by any ordering,
   * including the one that shipped: production holds a credential for
   * ElevenLabs and none for DigitalOcean, so putting fal back in front would
   * restore the original failure for every episode while a positional
   * assertion stayed green.
   */
  it('leads with the provider production holds a credential for', () => {
    expect(LIVE_CHAIN[0]?.provider).toBe('elevenlabs');
    expect(LIVE_CHAIN[0]?.modelId).toBe('eleven_text_to_sound_v2');
    // Both ids the endpoint accepts, and no third: MEASURED, its 422 names
    // exactly these two, so a mapping outside them fails on its first call.
    expect(LIVE_CHAIN.filter((m) => m.provider === 'elevenlabs').map((m) => m.modelId)).toEqual([
      'eleven_text_to_sound_v2',
      'eleven_text_to_sound_v3',
    ]);
    // And it keeps the route that used to be the only one, so it serves the day
    // a key for it arrives rather than being deleted.
    expect(LIVE_CHAIN.map((m) => m.modelId)).toContain('fal-ai/stable-audio-25/text-to-audio');
  });

  it('asks the tier by name, so a renamed tier is a failure and not an empty chain', async () => {
    await synthesizeSoundEffect({ prompt: PROMPT });
    expect(vi.mocked(getModelMappingsForTier)).toHaveBeenCalledWith('v1-sfx');
  });
});

describe('synthesizeSoundEffect walks that chain', () => {
  it('takes the first provider that answers, and asks no further', async () => {
    const effect = await synthesizeSoundEffect({ prompt: PROMPT });

    expect(effect).not.toBeNull();
    expect(effect?.audio).toBe(AUDIO);
    expect(effect?.format).toBe('mp3');
    expect(routed()).toEqual([['elevenlabs', 'eleven_text_to_sound_v2']]);
  });

  /**
   * THE assertion. The production failure was `Provider API exhausted:
   * digitalocean/… (no_credential)` thrown out of the one call there was; here
   * the same throw is followed by a second provider and an episode that keeps
   * its sound.
   */
  it('produces the effect anyway when the leading model fails', async () => {
    vi.mocked(callProviderAPI)
      .mockRejectedValueOnce(Object.assign(new Error('Provider API exhausted'), { reason: 'format' }))
      .mockResolvedValueOnce(AUDIO);

    const effect = await synthesizeSoundEffect({ prompt: PROMPT });

    expect(effect?.audio).toBe(AUDIO);
    // The next MODEL, on the same credential — which is the only thing a second
    // ElevenLabs entry can cover.
    expect(routed()).toEqual([
      ['elevenlabs', 'eleven_text_to_sound_v2'],
      ['elevenlabs', 'eleven_text_to_sound_v3'],
    ]);
  });

  /**
   * THE assertion, and the one the shipped code could not satisfy at any price.
   *
   * The production failure was `Provider API exhausted: digitalocean/… 
   * (no_credential)` thrown out of the one call there was. A credential fault
   * takes every mapping of that provider with it, so reaching another PROVIDER
   * is the only thing that saves the cue — and it is the claim a chain of three
   * entries on one key would fail while looking identical.
   */
  it('crosses to a second PROVIDER when a whole credential is gone', async () => {
    const exhausted = () =>
      Object.assign(new Error('Provider API exhausted'), { reason: 'no_credential' });
    vi.mocked(callProviderAPI)
      .mockRejectedValueOnce(exhausted())
      .mockRejectedValueOnce(exhausted())
      .mockResolvedValueOnce(AUDIO);

    const effect = await synthesizeSoundEffect({ prompt: PROMPT });

    expect(effect?.audio).toBe(AUDIO);
    const providers = routed().map(([provider]) => provider);
    expect(new Set(providers).size).toBeGreaterThanOrEqual(2);
    expect(providers.at(-1)).toBe('digitalocean');
  });

  it('treats an empty response as no audio and tries the next provider', async () => {
    // A 200 carrying nothing is not a sound. Accepting it would put a zero-byte
    // segment into the join, which ffmpeg reports as a corrupt input for the
    // WHOLE episode rather than for the one cue.
    vi.mocked(callProviderAPI)
      .mockResolvedValueOnce(Buffer.alloc(0))
      .mockResolvedValueOnce(AUDIO);

    const effect = await synthesizeSoundEffect({ prompt: PROMPT });

    expect(effect?.audio).toBe(AUDIO);
    expect(routed()).toHaveLength(2);
  });

  /**
   * Exhaustion is `null`, never a throw.
   *
   * `renderSegments` skips a segment that answers null and treats a throw the
   * same way, so this looks cosmetic and is not: the pipeline's own comment
   * says a missing transition whoosh must not cost the episode, and a function
   * that threw would make every caller responsible for remembering that.
   */
  it('answers null when every provider is exhausted, rather than throwing', async () => {
    vi.mocked(callProviderAPI).mockRejectedValue(new Error('nothing is reachable'));

    await expect(synthesizeSoundEffect({ prompt: PROMPT })).resolves.toBeNull();
    expect(routed()).toHaveLength(LIVE_CHAIN.length);
  });

  it('sends the neutral body every provider in the tier is translated from', async () => {
    await synthesizeSoundEffect({ prompt: PROMPT });

    const call = vi.mocked(callProviderAPI).mock.calls[0]?.[0];
    expect(call?.endpoint).toBe('/v1/sound-generation');
    expect(call?.body).toEqual({ prompt: PROMPT, duration_seconds: 5 });
    // Binary, not JSON: an effect is bytes, and a `json` read of an MP3 throws
    // inside the router where it reads as a provider failure.
    expect(call?.responseType).toBe('arrayBuffer');
  });

  it('stops before calling anything when the caller has already given up', async () => {
    const aborted = AbortSignal.abort();

    await expect(synthesizeSoundEffect({ prompt: PROMPT, signal: aborted })).resolves.toBeNull();
    expect(vi.mocked(callProviderAPI)).not.toHaveBeenCalled();
  });

  /**
   * A census over the SHIPPED chain rather than over the two entries this file
   * names, so it keeps meaning something after a third is added — including on
   * the day one is added that the loop cannot in fact reach.
   */
  it('can reach every mapping in the live chain, one at a time', async () => {
    expect(LIVE_CHAIN.length).toBeGreaterThanOrEqual(2);

    for (const mapping of LIVE_CHAIN) {
      vi.mocked(callProviderAPI).mockClear();
      vi.mocked(getModelMappingsForTier).mockResolvedValue([mapping]);

      const effect = await synthesizeSoundEffect({ prompt: PROMPT });

      expect(effect?.audio).toBe(AUDIO);
      expect(routed()).toEqual([[mapping.provider, mapping.modelId]]);
    }
  });
});
