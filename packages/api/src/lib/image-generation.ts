/**
 * Generating one image, across whichever providers the image tier offers.
 *
 * ## Why this is a module and not a route handler
 *
 * It was inline in `routes/v1/images.ts`, which meant the second product
 * feature that needed a generated image — cover art for a show series — had to
 * either call its own HTTP endpoint or copy the loop. Copying it would have
 * opened a SECOND path coupled to the provider tree, and `architectureGates`
 * gate 1 freezes that coupling as a list that may only shrink.
 *
 * So the provider knowledge moved here rather than being duplicated: this
 * module now holds the two exemptions `routes/v1/images.ts` used to hold, the
 * route is an ordinary caller, and there is ONE thing to delete when the image
 * path moves to Kaana under #139 workstream 7 instead of two.
 *
 * ## Two return shapes, because the callers want different things
 *
 * A provider answers with either an inline base64 payload or a URL of its own.
 * `generateImage` reports which, unchanged, because `/v1/images/generations`
 * passes a provider URL through untouched and must keep doing so — storing
 * every generated image would change what that endpoint costs and what it
 * returns. `generateImageBytes` is for a caller that needs the actual bytes,
 * and downloads the URL case itself.
 */

import { callProviderAPI, getModelMappingsForTier } from './gateway-client.js';
import { imageRequestBody } from '../internal/providers/lib/image-providers.js';
import {
  extractImageUrl,
  downloadBinaryFromUrl,
} from '../internal/providers/lib/digitalocean-async.js';
import { log } from './logger.js';

export interface ImageGenerationRequest {
  readonly prompt: string;
  readonly n?: number;
  readonly size?: string;
  readonly quality?: string;
  readonly responseFormat?: string;
  /** Per attempt, not for the whole tier walk. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * What a provider answered with, kept apart on purpose.
 *
 * These used to share one variable in the route, which is how a stored KEY
 * could be returned to a client as if it were a link — the same conflation that
 * made every stored address a 403.
 */
export type GeneratedImage =
  | { readonly kind: 'bytes'; readonly bytes: Buffer }
  | { readonly kind: 'url'; readonly url: string };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Walk the image tier and return the first image any provider produces.
 *
 * A provider that fails is logged and skipped — that is what the tier list is
 * for. `null` means every one of them failed or the tier is empty, which the
 * caller decides how to report: the route refunds and answers 503, a cover
 * falls back to no artwork.
 */
export async function generateImage(
  request: ImageGenerationRequest,
): Promise<GeneratedImage | null> {
  const mappings = await getModelMappingsForTier('v1-image');

  for (const mapping of mappings) {
    if (request.signal?.aborted === true) break;

    try {
      const data = await callProviderAPI<{ data?: Array<{ b64_json?: string }> }>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint: '/v1/images/generations',
        // Shaped per provider: `/v1/images/generations` is OpenAI-SHAPED rather
        // than OpenAI-identical, and a parameter a provider refuses fails the
        // whole request rather than degrading.
        body: imageRequestBody(mapping.provider, {
          modelId: mapping.modelId,
          prompt: request.prompt,
          n: request.n ?? 1,
          size: request.size ?? '1024x1024',
          quality: request.quality ?? 'standard',
          responseFormat: request.responseFormat ?? 'url',
        }),
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxAttempts: 1,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      const inline = data.data?.[0]?.b64_json;
      if (typeof inline === 'string' && inline !== '') {
        return { kind: 'bytes', bytes: Buffer.from(inline, 'base64') };
      }

      const url = extractImageUrl(data);
      if (typeof url === 'string' && url !== '') {
        return { kind: 'url', url };
      }

      log.general.warn(
        { provider: mapping.provider, model: mapping.modelId },
        'Image provider returned neither a URL nor inline data',
      );
    } catch (err: unknown) {
      log.general.warn(
        { err, provider: mapping.provider, model: mapping.modelId },
        'Image provider failed, trying next',
      );
    }
  }

  // One line for the walk as a whole, and it is not a duplicate of the ones
  // above. Those are emitted per mapping, so an EMPTY tier produces no output
  // at all — `null` with nothing to find it by, which is indistinguishable from
  // never having been asked. It also gives a caller that degrades quietly, like
  // a show cover, something an operator can search for after the fact.
  log.general.warn(
    { attempted: mappings.length, aborted: request.signal?.aborted === true },
    'No image provider produced an image',
  );
  return null;
}

/**
 * The same walk, resolved all the way to bytes.
 *
 * For a caller that has to hand the image to somebody else — Syra re-hosts
 * artwork rather than hotlinking it, so a provider URL that expires in an hour
 * is of no use to it.
 */
export async function generateImageBytes(
  request: ImageGenerationRequest,
): Promise<Buffer | null> {
  const generated = await generateImage(request);
  if (generated === null) return null;
  if (generated.kind === 'bytes') return generated.bytes;

  try {
    return await downloadBinaryFromUrl(generated.url);
  } catch (err: unknown) {
    // The image exists at the provider and cannot be fetched. Reporting `null`
    // rather than the URL is what stops a caller storing an address that
    // expires, which is the failure this whole shape exists to prevent.
    log.general.warn({ err }, 'A generated image could not be downloaded');
    return null;
  }
}
