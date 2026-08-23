import { describe, expect, it } from 'vitest';

import { imageRequestBody } from '../image-providers.js';
import { GENERATED_TIER_MAPPINGS } from '../generate-model-mappings.js';

/**
 * `/v1/images/generations` is OpenAI-SHAPED, not OpenAI-identical.
 *
 * MEASURED against xAI on 2026-08-23, one parameter at a time against a live
 * key — one at a time because the failure is per-parameter and the response
 * body is EMPTY, so a single failed call names nothing:
 *
 *   model+prompt        200      +size      400
 *   +n                  200      +quality   422
 *   +response_format    200
 *
 * The route's own body carries all four, so before this translation existed an
 * xAI mapping would have been refused on every request while looking perfectly
 * correct in the routing table.
 */
const REQUEST = {
  modelId: 'grok-imagine-image',
  prompt: 'a red apple',
  n: 1,
  size: '1024x1024',
  quality: 'standard',
  responseFormat: 'url',
};

describe('imageRequestBody strips what a provider refuses', () => {
  it('drops exactly the two parameters xAI rejects, and keeps the rest', () => {
    const body = imageRequestBody('xai', REQUEST);
    expect(Object.keys(body).sort()).toEqual(['model', 'n', 'prompt', 'response_format']);
    expect(body.model).toBe('grok-imagine-image');
    expect(body.prompt).toBe('a red apple');
  });

  it('leaves an unmeasured provider EXACTLY as it was', () => {
    // The reason this is an omission list and not an allow-list. Every existing
    // mapping relies on the full body; an allow-list would quietly degrade
    // providers nobody has measured instead of leaving them unchanged.
    const body = imageRequestBody('openai', REQUEST);
    expect(body).toEqual({
      model: 'grok-imagine-image',
      prompt: 'a red apple',
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'url',
    });
    // And the default is genuinely the default, not a second xAI branch.
    expect(imageRequestBody('digitalocean', REQUEST)).toEqual(body);
  });

  it('does not hand two providers the same object to edit', () => {
    // They are tried in one failover loop. A shared body would carry the first
    // provider's deletions into the second, so the fallback would send xAI's
    // stripped body to OpenAI — a bug that only appears on the SECOND attempt.
    const first = imageRequestBody('xai', REQUEST);
    const second = imageRequestBody('openai', REQUEST);
    expect(first).not.toBe(second);
    expect(second.size).toBe('1024x1024');
  });

  it('the image tier actually names xai, or this module translates nothing', () => {
    // The "green and inert" guard. The translation above is only reachable if a
    // mapping routes to xAI; without this the suite would pass with the mapping
    // deleted and image generation silently back to zero usable providers.
    const providers = GENERATED_TIER_MAPPINGS['v1-image'].map((m) => m.provider);
    expect(providers).toContain('xai');
    const xai = GENERATED_TIER_MAPPINGS['v1-image'].filter((m) => m.provider === 'xai');
    expect(xai.map((m) => m.modelId)).toEqual(['grok-imagine-image']);
  });
});
