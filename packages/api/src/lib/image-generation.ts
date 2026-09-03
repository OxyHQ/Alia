/** Image generation fails closed until Kaana exposes an image seam. */

import { kaanaCapabilityUnavailable } from './inference/hosted-capability-error.js';

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

/** Refuses without resolving a model, credential or provider. */
export async function generateImage(
  _request: ImageGenerationRequest,
): Promise<GeneratedImage | null> {
  throw kaanaCapabilityUnavailable('image_generation');
}

/**
 * The same walk, resolved all the way to bytes.
 *
 * Kept as the bytes-oriented product seam for callers that store artwork.
 */
export async function generateImageBytes(
  request: ImageGenerationRequest,
): Promise<Buffer | null> {
  return generateImage(request).then((generated) => generated?.kind === 'bytes' ? generated.bytes : null);
}
