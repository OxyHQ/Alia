import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A show series got no cover art in production, and the series was created
 * anyway — which is the design, and is also why nobody found out until a person
 * looked at the podcast.
 *
 * MEASURED, `/oxy/ecs` stream `alia/alia/*`, 2026-08-24 21:52:20–21 UTC, the
 * request that created the series. `generateImage` walked all five `v1-image`
 * mappings and every one failed:
 *
 *     openai/dall-e-3                        no_credential
 *     digitalocean/openai-gpt-image-1        no_credential
 *     digitalocean/fal-ai/flux/schnell       no_credential
 *     digitalocean/fal-ai/fast-sdxl          no_credential
 *     xai/grok-imagine-image                 Provider "xai" has no configured base URL
 *
 * The first four are an operator's problem: production holds no key for either
 * provider. The fifth is this repo's. xAI is the ONE image provider a key
 * exists for — the mapping was added for exactly that reason — and
 * `provider-api.ts` cannot build a URL for it, because `PROVIDER_BASES` names
 * four providers and xai is not among them. The request never left the process.
 *
 * So the test drives the real cover path — `generateCoverArt` →
 * `generateImageBytes` → `generateImage` → `getModelMappingsForTier('v1-image')`
 * → `callProviderAPI` → `fetch` — with only the two things a test may not have
 * replaced: the key store, and the network. Everything between them is the code
 * that ran in production.
 */

vi.mock('../../../internal/providers/lib/key-manager.js', () => ({
  // Every provider holds a key, so a mapping that fails here fails for a reason
  // that is NOT a missing credential. Production's four `no_credential`
  // mappings would otherwise mask the fifth, which is the one this is about.
  getBestKeyForModel: async (provider: string, modelId: string) => ({
    keyId: `key-${provider}`,
    provider,
    modelId,
    key: 'test-key-not-a-credential',
  }),
  recordKeySuccess: async () => {},
  recordKeyFailure: async () => {},
  recordKeyUsage: async () => {},
  markKeyCreditExhausted: async () => {},
}));

import { generateCoverArt } from '../cover-art.js';
import { generateImage } from '../../image-generation.js';
import { log } from '../../logger.js';
import { GENERATED_TIER_MAPPINGS } from '../../../internal/providers/lib/generate-model-mappings.js';

const XAI_IMAGES = 'https://api.x.ai/v1/images/generations';
const HOSTED_IMAGE = 'https://images.test.invalid/generated.png';
const PNG_BYTES = Buffer.from('a-generated-cover', 'utf8');

/** Every URL `fetch` was asked for, in order, across the whole tier walk. */
let requested: string[] = [];
/** Every `log.general.warn`, so the walk's own account of itself is measurable. */
let warned: { fields: Record<string, unknown>; message: string }[] = [];
/** The body sent to xAI, so the assertions can prove WHICH request served. */
let xaiBody: Record<string, unknown> | null = null;

/**
 * The network, and nothing else, replaced.
 *
 * `serveXai: false` is the vacuity floor: the same harness with the one
 * provider that can answer taken away. Without it, "a Buffer came back" would
 * be satisfied by any code path that invents a placeholder.
 */
function stubNetwork(serveXai: boolean): void {
  requested = [];
  xaiBody = null;
  warned = [];
  vi.spyOn(log.general, 'warn').mockImplementation(((fields: unknown, message?: string) => {
    warned.push({
      fields: (typeof fields === 'object' && fields !== null ? fields : {}) as Record<string, unknown>,
      message: message ?? String(fields),
    });
    return undefined;
  }) as typeof log.general.warn);
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);

      if (url === XAI_IMAGES && serveXai) {
        xaiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ data: [{ url: HOSTED_IMAGE }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === HOSTED_IMAGE) {
        return new Response(PNG_BYTES, { status: 200 });
      }

      // Every other provider: no key of ours reaches it, so nothing answers.
      throw new Error('no route to this provider from a test');
    },
  );
}

beforeEach(() => stubNetwork(true));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cover art for a show series', () => {
  it('reaches the one image provider a key exists for, and returns its bytes', async () => {
    const art = await generateCoverArt('Cocina de Barrio', 'Recetas de la abuela', 'podcast');

    // The symptom, first: production got `null` here and created the series
    // without artwork.
    expect(art).not.toBeNull();
    expect(art?.equals(PNG_BYTES)).toBe(true);

    // The cause, named exactly. Before the fix this URL is never built: the
    // transport throws "has no configured base URL" and `fetch` is not called.
    expect(requested).toContain(XAI_IMAGES);

    // And it is the COVER that was drawn, not some other image request — the
    // prompt carries the title the caller passed.
    expect(String(xaiBody?.prompt)).toContain('Cocina de Barrio');
    // The parameters xAI refuses are still stripped on the way (400 and 422
    // respectively, measured in `image-providers.test.ts`), so reaching the
    // endpoint is not the same as being served by it.
    expect(xaiBody).not.toHaveProperty('size');
    expect(xaiBody).not.toHaveProperty('quality');
  });

  it('answers null when nothing serves, rather than inventing a cover', async () => {
    stubNetwork(false);

    const art = await generateCoverArt('Cocina de Barrio', 'Recetas de la abuela', 'podcast');

    expect(art).toBeNull();
    // The floor: it still ASKED. A `null` from an empty tier and a `null` from
    // a tier that was walked and refused look identical to a caller, and only
    // one of them is this test's subject.
    expect(requested).toContain(XAI_IMAGES);

    // And it left a trace of the walk as a whole. The per-provider warnings are
    // emitted inside the loop, so an EMPTY tier produces none at all — the one
    // shape that answers `null` having said nothing. This line is outside the
    // loop, which is what makes both shapes findable afterwards.
    const summary = warned.filter((entry) => entry.message === 'No image provider produced an image');
    expect(summary).toHaveLength(1);
    expect(summary[0]?.fields.attempted).toBe(GENERATED_TIER_MAPPINGS['v1-image'].length);
  });

  it('every mapping in the image tier can be addressed by the transport', async () => {
    // The general form of the defect, over the tier `generateImage` actually
    // reads rather than a list maintained here. A mapping whose provider the
    // transport cannot build a URL for is dead the day it is added, and looks
    // perfectly correct in the routing table — which is how this one shipped.
    const mappings = GENERATED_TIER_MAPPINGS['v1-image'];
    expect(mappings.length).toBeGreaterThan(0);

    stubNetwork(false);
    await generateImage({ prompt: 'a red apple' });

    // DigitalOcean's fal-ai models take the async-invoke branch, which builds
    // its own URL from its own base; the rest go through `PROVIDER_BASES`.
    // Either way the mapping must produce an outbound request.
    const hosts = new Set(requested.map((url) => new URL(url).host));
    expect(hosts).toContain('api.openai.com');
    expect(hosts).toContain('inference.do-ai.run');
    expect(hosts).toContain('api.x.ai');
    expect(hosts.size).toBe(new Set(mappings.map((m) => m.provider)).size);
  });
});
