/**
 * Cover art for a show series.
 *
 * A podcast without artwork is a grey square in every listing, so a series gets
 * a generated cover at creation. The owner can replace it afterwards; nothing
 * here is permanent.
 *
 * ## Failing to draw a cover must never fail the series
 *
 * Every function here answers `null` rather than throwing. An image model being
 * busy is a routine condition, and a series that could not be created because of
 * one would be a podcast the user cannot make while its most replaceable
 * property is unavailable. Syra's own `podcastArtworkUrl` answers `undefined`
 * when a show has no image, so an absent cover is a case Syra's surfaces already
 * handle — which is why the fallback is "no image" rather than one shared
 * placeholder file uploaded under every AI-generated show. A single stock square
 * across every such podcast would be a worse default than Syra's own, and it
 * would be maintained here rather than where the rest of Syra's empty states
 * live.
 */

import { callProviderAPI, getModelMappingsForTier } from '../gateway-client.js';
import { imageRequestBody } from '../../internal/providers/lib/image-providers.js';
import { extractImageUrl } from '../../internal/providers/lib/digitalocean-async.js';
import { downloadBinaryFromUrl } from '../../internal/providers/lib/digitalocean-async.js';
import { log } from '../logger.js';
import type { ShowFormat } from '../../db/schema/shows.js';

/** Square, because podcast artwork is square everywhere it is rendered. */
const COVER_SIZE = '1024x1024';

/** Per attempt. A cover is not worth holding a request open longer than this. */
const COVER_TIMEOUT_MS = 45_000;

/**
 * How each format should look. Short, because an image model given a paragraph
 * of art direction renders the paragraph's nouns rather than its intent.
 */
const FORMAT_STYLE: Record<ShowFormat, string> = {
  podcast: 'warm, friendly, two-tone illustration with a relaxed conversational mood',
  news: 'crisp, high-contrast editorial design with a sense of urgency',
  debate: 'bold, symmetrical composition suggesting two opposing sides',
  interview: 'intimate, portrait-like composition with soft studio lighting',
  explainer: 'clean, diagrammatic illustration with a single clear focal idea',
};

/**
 * The prompt for one cover.
 *
 * **No text, stated twice.** Image models render lettering as plausible-looking
 * gibberish, and a podcast cover carrying misspelled words is worse than one
 * carrying none — the title is already displayed beside the artwork by every
 * client that shows it.
 *
 * The brief is truncated rather than passed whole: it is the owner's free text,
 * it can be long, and everything past the first couple of sentences dilutes the
 * subject the model actually draws.
 */
export function buildCoverPrompt(title: string, brief: string, format: ShowFormat): string {
  const style = FORMAT_STYLE[format];
  return [
    `Podcast cover artwork for a show called "${title}".`,
    `Subject: ${brief.slice(0, 300)}`,
    `Style: ${style}. Square composition, striking at thumbnail size.`,
    'Absolutely no text, no words, no letters and no numbers anywhere in the image.',
  ].join('\n');
}

/**
 * Draw a cover, or answer `null`.
 *
 * Walks the same image tier and the same provider fall-back the images endpoint
 * uses, so a provider that is failing degrades identically on both surfaces
 * rather than in two ways somebody has to learn separately.
 *
 * Both response shapes are handled because providers disagree: some answer with
 * a URL to fetch, some with base64 inline. The caller wants BYTES either way —
 * it is going to hand them to Syra, which re-hosts artwork rather than
 * hotlinking it, so a URL that expires in an hour is of no use to anyone.
 */
export async function generateCoverArt(
  title: string,
  brief: string,
  format: ShowFormat,
): Promise<Buffer | null> {
  const prompt = buildCoverPrompt(title, brief, format);
  const mappings = await getModelMappingsForTier('v1-image');

  for (const mapping of mappings) {
    try {
      const data = await callProviderAPI<{ data?: Array<{ b64_json?: string }> }>({
        provider: mapping.provider,
        modelId: mapping.modelId,
        endpoint: '/v1/images/generations',
        // Shaped per provider: `/v1/images/generations` is an OpenAI-shaped
        // endpoint that providers implement in part, and a parameter one of them
        // does not accept fails the whole request rather than degrading.
        body: imageRequestBody(mapping.provider, {
          modelId: mapping.modelId,
          prompt,
          n: 1,
          size: COVER_SIZE,
          quality: 'standard',
          responseFormat: 'url',
        }),
        timeout: COVER_TIMEOUT_MS,
        maxAttempts: 1,
      });

      const inline = data.data?.[0]?.b64_json;
      if (typeof inline === 'string' && inline !== '') {
        return Buffer.from(inline, 'base64');
      }

      const url = extractImageUrl(data);
      if (url !== null && url !== undefined && url !== '') {
        return await downloadBinaryFromUrl(url);
      }

      log.general.warn(
        { provider: mapping.provider, model: mapping.modelId },
        'Image provider returned neither a URL nor inline data for a show cover',
      );
    } catch (err: unknown) {
      // Warn and continue: the next provider is the whole point of the tier
      // list, and a cover is the one part of a series that may simply not
      // happen.
      log.general.warn(
        { err, provider: mapping.provider, model: mapping.modelId },
        'Show cover generation failed, trying the next provider',
      );
    }
  }

  return null;
}
