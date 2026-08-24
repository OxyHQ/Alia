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

import { generateImageBytes } from '../image-generation.js';
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
 * Through `lib/image-generation.ts`, which is the ONE image path in this
 * package — the same walk `POST /v1/images/generations` takes, so a provider
 * that is failing degrades identically on both surfaces rather than in two ways
 * somebody has to learn separately. It also means this module has no coupling to
 * the provider tree at all, which gate 1 of `__tests__/architectureGates.test.ts`
 * requires of anything new.
 *
 * Bytes rather than a URL, because Syra re-hosts artwork rather than hotlinking
 * it: a provider link that expires in an hour is of no use to it.
 */
export async function generateCoverArt(
  title: string,
  brief: string,
  format: ShowFormat,
): Promise<Buffer | null> {
  return generateImageBytes({
    prompt: buildCoverPrompt(title, brief, format),
    n: 1,
    size: COVER_SIZE,
    quality: 'standard',
    responseFormat: 'url',
    timeoutMs: COVER_TIMEOUT_MS,
  });
}
