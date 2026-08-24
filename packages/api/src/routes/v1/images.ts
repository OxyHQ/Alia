import { Router } from 'express';
import { generateImage } from '../../lib/image-generation.js';
import { reserveCredits, finalizeCredits, refundReservation, CREDITS_CONFIG } from '../../lib/credits-manager.js';
import type { CreditReservation } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { uploadToS3 } from '../../lib/s3.js';
import { storedMediaUrl } from '../../lib/stored-media.js';
import { log } from '../../lib/logger.js';
import { getSafeErrorMessage } from '../../lib/errors/sanitize.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * What one generated image costs. The endpoint has always said five; until now
 * it charged one.
 *
 * The number is not new and is not a repricing — it is the figure the comment
 * below the reservation has stated all along, now written where it can be read
 * and converted rather than pre-multiplied into a token count nobody could
 * check.
 */
const CREDITS_PER_IMAGE = 5;

/**
 * POST /v1/images/generations
 * OpenAI-compatible image generation endpoint with provider fallback.
 *
 * Body: { prompt, n?, size?, quality?, response_format? }
 * Returns: { data: [{ url: string }] }
 */
router.post('/generations', async (req: Request, res: Response) => {
  const TIMEOUT_MS = 60_000;
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort('Image gen global timeout'), TIMEOUT_MS);

  /**
   * Out here so the `catch` can give it back. A reservation DEBITS immediately,
   * so an exit that neither charges nor refunds keeps the caller's credit —
   * and while this lived inside the `try` the catch could not name it.
   * Same defect, same shape, as `routes/v1/audio.ts` carried.
   */
  let reservation: CreditReservation | null = null;
  let settled = false;

  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { prompt, n, size, quality, response_format } = req.body as {
      prompt?: string;
      n?: number;
      size?: string;
      quality?: string;
      response_format?: string;
    };

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: { message: 'Prompt is required', type: 'invalid_request_error' } });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({ error: { message: 'Prompt exceeds 4000 character limit', type: 'invalid_request_error' } });
    }

    // Ensure user has credits
    await getOrCreateUserCredits(userId);
    reservation = await reserveCredits(userId);
    if (!reservation) {
      return res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: "You've run out of credits. Add more or upgrade your plan to continue.",
          retryable: false,
          suggestedAction: 'upgrade',
          details: { limitType: 'credits' },
        },
      });
    }

    /**
     * The provider walk lives in `lib/image-generation.ts` now, so the cover-art
     * path can reach the same one instead of opening a second route into the
     * provider tree — see gate 1 of `__tests__/architectureGates.test.ts`, whose
     * exemption list may only shrink.
     *
     * What stays HERE is the decision about storage, because it is this
     * endpoint's contract: a provider's own URL is passed through untouched, and
     * inline bytes are stored and identified by a KEY. The two used to share one
     * variable, which is how a key was once returned to a client as if it were a
     * link.
     */
    const generated = await generateImage({
      prompt,
      n: n || 1,
      size: size || '1024x1024',
      quality: quality || 'standard',
      responseFormat: response_format || 'url',
      signal: abortController.signal,
    });

    let providerImageUrl: string | null = null;
    let storedImageKey: string | null = null;
    if (generated?.kind === 'url') {
      providerImageUrl = generated.url;
    } else if (generated?.kind === 'bytes') {
      storedImageKey = await uploadToS3(generated.bytes, 'image.png', `images/${userId}`, 'generated');
    }

    if (!providerImageUrl && !storedImageKey) {
      // Refund, not a zero-token finalize: `calculateCreditsFromTokens` returns
      // MIN_CREDITS_PER_REQUEST for zero tokens, so this billed the minimum for
      // a request that produced no image.
      settled = true;
      await refundReservation(reservation);
      const status = abortController.signal.aborted ? 504 : 503;
      return res.status(status).json({ error: { message: 'Image generation failed — please try again', type: 'server_error' } });
    }

    /**
     * Charge credits for image generation (~5 credits per image), stated in the
     * unit `finalizeCredits` settles in.
     *
     * It settles TOKENS, not credits: `calculateCreditsFromTokens` divides by
     * `TOKENS_PER_CREDIT` and applies the alias model's multiplier. So a figure
     * already denominated in CREDITS survives the round trip only if it is
     * multiplied by `TOKENS_PER_CREDIT` on the way in.
     *
     * THE ROUND TRIP IS EXACT ONLY WHILE THE MULTIPLIER IS 1. The general form
     * is `ceil(credits * multiplier)`, and the multiplier comes from the alias
     * model's `credit_multiplier`; it is 1 here for the one reason that this
     * call passes no `aliasModelId`. That is invisible from the argument list,
     * so it is written down: threading an alias model through this endpoint
     * silently reprices it, and nothing in the type system would say so.
     *
     * It was a hardcoded 250 tokens, which is this same 5 pre-multiplied by 50
     * — a fiftieth of a credit apiece against a thousand-token credit. Every
     * image ever generated settled at `ceil(250 / 1000)`, floored to
     * `MIN_CREDITS_PER_REQUEST` = 1. Flat, unconditional, a fifth of the price.
     *
     * One image, not `n` of them: the handler reads `data[0]` and answers with
     * a single URL whatever `n` asked for, so per-image and per-request are the
     * same charge here. Billing `n * CREDITS_PER_IMAGE` would charge for images
     * this endpoint does not return.
     */
    settled = true;
    await finalizeCredits(reservation, {
      promptTokens: CREDITS_PER_IMAGE * CREDITS_CONFIG.TOKENS_PER_CREDIT,
      completionTokens: 0,
      totalTokens: CREDITS_PER_IMAGE * CREDITS_CONFIG.TOKENS_PER_CREDIT,
    });

    // A stored image becomes addressable here; a provider's own URL is already
    // one and is not rewritten.
    const url = storedImageKey === null ? providerImageUrl : storedMediaUrl(req, storedImageKey, userId);
    if (url === null) {
      return res.status(500).json({ error: { message: 'The image cannot be served by this deployment', type: 'server_error' } });
    }
    res.json({ data: [{ url }] });
  } catch (error: unknown) {
    if (reservation && !settled) {
      await refundReservation(reservation).catch((err: unknown) =>
        log.general.error({ err, userId: req.user?.id }, 'refundReservation failed after image error'));
    }
    const timedOut = abortController.signal.aborted;
    log.general.error({ err: error, userId: req.user?.id, timedOut }, 'Image generation failed');
    const status = timedOut ? 504 : 500;
    res.status(status).json({ error: { message: getSafeErrorMessage(error, 'Image generation failed'), type: 'server_error' } });
  } finally {
    clearTimeout(globalTimer);
  }
});

export default router;
