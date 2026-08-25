/**
 * Show series and episodes — the product surface, mounted at `/shows`.
 *
 * ## Why this is not on `/v1` any more
 *
 * It used to be, and `/v1` is a frozen compatibility surface that ADR 0004 and
 * `docs/migration/compatibility-window.md` both close to new routes: *"The
 * surface gains no new capability, no new route and no new model. It is not the
 * place a new feature ships."* Shows are a product feature, so they belong
 * beside `/conversations`, `/skills`, `/agents` and `/library`, which is where
 * every other per-user Alia resource lives.
 *
 * The compatibility-window document recorded this as an open question in as many
 * words — *"Whether `/v1/shows` belongs to this window at all … it may leave
 * this document entirely"* — and the workstream 1 inventory had already answered
 * it: all five old routes carry `"proposedOwner": "alia"` and
 * `"targetPath": "keep-alia-product"`. Each one's recorded removal gate is a
 * line in `packages/app/lib/stores/show-store.ts`, and that file moves in the
 * same change, so the gate is satisfied by construction rather than waived.
 *
 * ## Syra is called with the USER's credential, always
 *
 * Creating a podcast, editing one and reserving an episode all happen here,
 * while the caller's Oxy token is live, because Syra authenticates a user and
 * nothing else. What the worker needs later is a single-use ingest ticket, which
 * these handlers mint and store. See `lib/syra/syra.ts`.
 *
 * ## Where an id comes from, and why the order looks backwards
 *
 * `show_series.syra_podcast_id` is NOT NULL, so the Syra podcast must exist
 * before the Alia row. Syra's `createPodcast` in turn wants `aliaSeriesId` for
 * provenance, so the Alia id must exist before the Syra podcast. The id is
 * therefore minted HERE with `uuidv7()` and passed into both — rather than left
 * to the column's default, which would only be known after the insert that needs
 * the podcast that needs the id.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { uuidv7 } from '@oxyhq/db';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  SHOW_FORMATS,
  SHOW_VISIBILITIES,
  type ShowFormat,
  type ShowVisibility,
} from '../db/schema/shows.js';
import {
  allocateEpisodeNumber,
  countActiveEpisodes,
  createEpisode,
  createSeries,
  deleteEpisodeForUser,
  deleteSeriesForUser,
  findEpisodeForUser,
  findPreferences,
  findSeriesForUser,
  listEpisodesForSeries,
  listSeriesForUser,
  updateEpisode,
  updateSeriesForUser,
  upsertPreferences,
  type ShowSeriesPatch,
} from '../db/shows/showRepository.js';
import { enqueueShowGeneration } from '../lib/show/show-queue.js';
import { buildSeriesCast, FORMAT_DEFAULTS, SHOW_VOICES } from '../lib/show/voice-roster.js';
import { generateCoverArt } from '../lib/show/cover-art.js';
import { syraForRequest } from '../lib/syra/syra.js';
import {
  refundReservation,
  reserveCredits,
  finalizeFixedCredits,
} from '../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { log } from '../lib/logger.js';
import { getSafeErrorMessage } from '../lib/errors/sanitize.js';

const router = Router();

/**
 * Every route here reads or writes one account's own shows, including the voice
 * catalogue — which is only useful to somebody about to create a series. No
 * route is anonymous, so the authentication is stated once rather than per
 * handler, where an omission would be invisible.
 */
router.use(authenticateToken);

/** What one cover costs, matching `POST /v1/images/generations`. */
const COVER_ART_CREDITS = 5;

/** The most episodes one account may have in flight at once. */
const MAX_CONCURRENT_EPISODES = 3;

const visibilitySchema = z.enum(SHOW_VISIBILITIES);
const formatSchema = z.enum(SHOW_FORMATS);

const createSeriesSchema = z.object({
  title: z.string().trim().min(3).max(200),
  brief: z.string().trim().min(10).max(2000),
  description: z.string().trim().max(2000).optional(),
  format: formatSchema.optional(),
  visibility: visibilitySchema.optional(),
  /** Chosen positionally per the format's roles; anything unrecognised is ignored. */
  voiceIds: z.array(z.string()).max(8).optional(),
});

const patchSeriesSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  brief: z.string().trim().min(10).max(2000).optional(),
  description: z.string().trim().max(2000).optional(),
  visibility: visibilitySchema.optional(),
  /** `true` draws a new cover, charged like the first one. */
  regenerateCover: z.boolean().optional(),
});

/**
 * Everything about one episode is OPTIONAL, including what it covers.
 *
 * The series already knows what the show is about, so asking for another
 * episode is a request with no body — `POST` with nothing at all is the normal
 * case, and the pipeline works the subject out from the brief and the subjects
 * earlier episodes used. `topic` survives as a STEER rather than a requirement:
 * an owner who wants this one to be about the election result should be able to
 * say so, and their words are then stored and used unchanged.
 *
 * There is no `title`. An episode's name is read off the finished script (see
 * `lib/show/episode-title.ts`), and a name typed before the episode exists is
 * the thing that change removed.
 */
const createEpisodeSchema = z.object({
  topic: z.string().trim().min(5).max(2000).optional(),
  notes: z.string().max(10_000).optional(),
  sourceConversationId: z.string().optional(),
});

const preferencesSchema = z.object({
  defaultVisibility: visibilitySchema,
  defaultFormat: formatSchema,
});

/** The one place a validation failure becomes a response, so all of them look alike. */
function invalid(res: Response, message: string): Response {
  return res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

function notFound(res: Response, what: string): Response {
  return res.status(404).json({ error: { message: `${what} not found`, type: 'not_found' } });
}

/* -------------------------------------------------------------------------- */
/*  Voices and preferences                                                    */
/* -------------------------------------------------------------------------- */

/** The catalogue a series is cast from, and how many speakers each format has. */
router.get('/voices', (_req: Request, res: Response) => {
  res.json({
    voices: SHOW_VOICES,
    formats: Object.entries(FORMAT_DEFAULTS).map(([format, config]) => ({
      format,
      roles: config.roles,
    })),
  });
});

/**
 * This account's defaults for a new series.
 *
 * An account that has never set any gets the schema's own defaults rather than
 * a 404: absence means "unset", and a client asking what the defaults are should
 * get them.
 */
router.get('/preferences', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const stored = await findPreferences(getDb(), userId);
    res.json({
      defaultVisibility: stored?.defaultVisibility ?? 'private',
      defaultFormat: stored?.defaultFormat ?? 'podcast',
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to read show preferences');
    res.status(500).json({ error: { message: 'Failed to read preferences', type: 'server_error' } });
  }
});

router.put('/preferences', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'defaultVisibility and defaultFormat are required');

    const saved = await upsertPreferences(getDb(), userId, parsed.data);
    res.json({
      defaultVisibility: saved.defaultVisibility,
      defaultFormat: saved.defaultFormat,
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to save show preferences');
    res.status(500).json({ error: { message: 'Failed to save preferences', type: 'server_error' } });
  }
});

/* -------------------------------------------------------------------------- */
/*  Series                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Draw a cover and store it in Syra, answering with Syra's image id.
 *
 * Charged, because it is a real image generation and an uncharged one is an
 * unlimited free image endpoint wearing a different name. Refunded whenever no
 * image results — a busy model must not cost anybody anything.
 *
 * `null` on every failure. A series with no artwork is a series; a request that
 * 500s because an image model was busy is not, and the cover is the most
 * replaceable thing about a show.
 *
 * ## Not blocking the series is not the same as leaving no trace
 *
 * Two of the three ways this answered `null` said nothing at all, so the only
 * evidence a series had no cover was the grey square somebody eventually
 * noticed. Every one of them now emits ONE message — the same message, so a
 * single search over the logs answers "which series have no artwork, and why" —
 * carrying the series id, its owner and the reason. The series still gets
 * created either way; that decision is untouched.
 */
async function mintCover(
  req: Request,
  userId: string,
  seriesId: string,
  title: string,
  brief: string,
  format: ShowFormat,
): Promise<string | null> {
  // `err` is named rather than spread in conditionally: pino omits an undefined
  // value, and `lib/__tests__/log-content.test.ts` freezes which two files may
  // spread into a log at all — a spread hides its keys from that census.
  const noCover = (reason: string, err?: unknown): null => {
    log.general.warn(
      { userId, seriesId, reason, err },
      'A show series was created without cover art',
    );
    return null;
  };

  await getOrCreateUserCredits(userId);
  const reservation = await reserveCredits(userId, COVER_ART_CREDITS);
  // Not an error: an account with no credits still gets its series, without art.
  if (!reservation) return noCover('insufficient_credits');

  try {
    const art = await generateCoverArt(title, brief, format);
    if (art === null) {
      await refundReservation(reservation);
      // Which provider refused, and why, is `image-generation.ts`'s to report —
      // this says only that a series is the thing that went without.
      return noCover('no_image_generated');
    }

    const uploaded = await syraForRequest(req).uploadPodcastImage(
      new Blob([new Uint8Array(art)], { type: 'image/png' }),
      'cover.png',
    );
    await finalizeFixedCredits(reservation, COVER_ART_CREDITS, 'show-cover');
    return uploaded.id;
  } catch (err: unknown) {
    // The art may have been drawn and the upload may have failed, so this can
    // refund work that really happened. That is the right side to err on: the
    // caller has nothing to show for it either way.
    await refundReservation(reservation).catch((refundErr: unknown) =>
      log.general.error({ err: refundErr, userId, seriesId }, 'refundReservation failed after a cover error'),
    );
    return noCover('cover_failed', err);
  }
}

/**
 * Create a series: cast it, draw a cover, create the Syra podcast, store the row.
 */
router.post('/series', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const parsed = createSeriesSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalid(res, 'A series needs a title of at least 3 characters and a brief of at least 10');
    }
    const input = parsed.data;

    const stored = await findPreferences(getDb(), userId);
    const format: ShowFormat = input.format ?? stored?.defaultFormat ?? 'podcast';
    const visibility: ShowVisibility =
      input.visibility ?? stored?.defaultVisibility ?? 'private';

    // Minted here, not by the column's default — Syra records it as provenance
    // and its podcast has to exist before the row that would generate one.
    const seriesId = uuidv7();
    const speakers = buildSeriesCast(format, input.voiceIds);
    const coverImageAssetId = await mintCover(req, userId, seriesId, input.title, input.brief, format);

    const podcast = await syraForRequest(req).createPodcast({
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(coverImageAssetId === null ? {} : { image: coverImageAssetId }),
      visibility,
      type: 'episodic',
      aliaSeriesId: seriesId,
      // Disclosure, and true: every episode of this show is machine-written and
      // machine-voiced.
      aiGenerated: true,
    });

    const series = await createSeries(getDb(), {
      id: seriesId,
      userId,
      syraPodcastId: podcast.id,
      title: input.title,
      description: input.description,
      format,
      brief: input.brief,
      speakers,
      visibility,
      coverImageAssetId: coverImageAssetId ?? undefined,
    });

    res.status(201).json(series);
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Failed to create a show series');
    res.status(500).json({
      error: { message: getSafeErrorMessage(error, 'Failed to create the series'), type: 'server_error' },
    });
  }
});

router.get('/series', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const { series, total } = await listSeriesForUser(getDb(), userId, limit, (page - 1) * limit);

    res.json({
      series,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to list show series');
    res.status(500).json({ error: { message: 'Failed to list series', type: 'server_error' } });
  }
});

/** One series, with its episodes. */
router.get('/series/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Series');

    const series = await findSeriesForUser(getDb(), id, userId);
    if (!series) return notFound(res, 'Series');

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const { episodes, total } = await listEpisodesForSeries(getDb(), series.id, limit, 0);

    res.json({ series, episodes, total });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to read a show series');
    res.status(500).json({ error: { message: 'Failed to read the series', type: 'server_error' } });
  }
});

/**
 * Edit a series, on BOTH sides.
 *
 * Syra is updated first. If it refuses, nothing is written here — which keeps
 * Alia from claiming a title or an audience the published podcast does not have.
 * The reverse order would leave the two disagreeing with Alia's copy looking
 * authoritative, and it is not: a listener sees Syra's.
 */
router.patch('/series/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Series');

    const parsed = patchSeriesSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, 'Nothing in that payload can be changed');
    const input = parsed.data;

    const series = await findSeriesForUser(getDb(), id, userId);
    if (!series) return notFound(res, 'Series');

    const cover = input.regenerateCover === true
      ? await mintCover(req, userId, series.id, input.title ?? series.title, input.brief ?? series.brief, series.format)
      : null;

    const syra = syraForRequest(req);
    if (
      input.title !== undefined ||
      input.description !== undefined ||
      input.visibility !== undefined ||
      cover !== null
    ) {
      await syra.updatePodcast(series.syraPodcastId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(cover === null ? {} : { image: cover }),
      });
    }

    const patch: ShowSeriesPatch = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.brief === undefined ? {} : { brief: input.brief }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(cover === null ? {} : { coverImageAssetId: cover }),
    };

    const updated = await updateSeriesForUser(getDb(), id, userId, patch);
    if (!updated) return notFound(res, 'Series');
    res.json(updated);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to update a show series');
    res.status(500).json({
      error: { message: getSafeErrorMessage(error, 'Failed to update the series'), type: 'server_error' },
    });
  }
});

/**
 * Forget a series, and its episodes with it.
 *
 * ALIA's record only. The Syra podcast is a published resource with its own
 * listeners and its own subscriptions, and deleting somebody's podcast because
 * they tidied up an Alia list would be a surprise of the worst kind. The
 * response says so explicitly rather than leaving a client to guess.
 */
router.delete('/series/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Series');

    const series = await findSeriesForUser(getDb(), id, userId);
    if (!series) return notFound(res, 'Series');

    const deleted = await deleteSeriesForUser(getDb(), id, userId);
    if (!deleted) return notFound(res, 'Series');

    res.json({ deleted: true, syraPodcastId: series.syraPodcastId, syraPodcastKept: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to delete a show series');
    res.status(500).json({ error: { message: 'Failed to delete the series', type: 'server_error' } });
  }
});

/* -------------------------------------------------------------------------- */
/*  Episodes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask for another episode. That is the whole request — a body is optional.
 *
 * Reserves the Syra episode NOW, while the caller's token is live, and stores
 * the ticket the worker will redeem minutes later with no credential of its own.
 * That ordering is the whole design and is not an implementation detail: see
 * `lib/syra/syra.ts`.
 *
 * ## What this handler no longer decides
 *
 * It used to decide the episode's subject — by requiring the caller to type one
 * — and its name, by asking a model to turn that subject into a title before a
 * word of the episode existed. Neither belongs here. The series' `brief` says
 * what the show is about and the earlier episodes' subjects say what it has
 * already used, so the subject is the script model's to choose from those; and
 * a name is worth having only once there is something to name it after.
 *
 * What is left is exactly the part that needs the caller's credential: allocate
 * the number, reserve the Syra draft, mint the ticket, queue the job.
 */
router.post('/series/:id/episodes', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Series');

    // `req.body` is `undefined` for a POST with no body at all, which is the
    // ordinary shape of this request. `z.object()` refuses `undefined`, so the
    // empty object is supplied here rather than letting "just another episode"
    // read as a malformed request.
    const parsed = createEpisodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return invalid(res, 'A topic, if you give one, needs at least 5 characters');
    }
    const input = parsed.data;

    const series = await findSeriesForUser(getDb(), id, userId);
    if (!series) return notFound(res, 'Series');

    const active = await countActiveEpisodes(getDb(), userId);
    if (active >= MAX_CONCURRENT_EPISODES) {
      return res.status(429).json({
        error: {
          message: `Maximum ${MAX_CONCURRENT_EPISODES} episodes generating at once. Please wait for one to finish.`,
          type: 'rate_limit_error',
        },
      });
    }

    // Atomic, and doubles as the ownership check — a series belonging to
    // somebody else answers null without a second read.
    const episodeNumber = await allocateEpisodeNumber(getDb(), series.id, userId);
    if (episodeNumber === null) return notFound(res, 'Series');

    /**
     * A PLACEHOLDER name, because Syra needs one to reserve the draft and this
     * request happens minutes before the episode exists.
     *
     * `createEpisodeDraft` requires a title, and nothing here knows what the
     * episode will say — the subject is usually not even decided yet. So the
     * one thing that is certainly true goes in: which episode it is. The
     * pipeline replaces it once the script is written, on this row and on
     * Syra's, and an episode whose run fails keeps this rather than a name
     * invented for an episode that never happened.
     *
     * This used to be a synchronous model call on the request path, guessing a
     * title from the topic. It is now no call at all, which is also why asking
     * for another episode is a single press: there is nothing left to answer.
     */
    const title = `Episode ${episodeNumber}`;

    const draft = await syraForRequest(req).createEpisodeDraft(series.syraPodcastId, {
      title,
      episodeNumber,
      aiGenerated: true,
    });

    const episode = await createEpisode(getDb(), {
      userId,
      seriesId: series.id,
      episodeNumber,
      title,
      // Absent unless the caller steered this one; the pipeline decides it and
      // writes it back the moment the script parses.
      topic: input.topic,
      notes: input.notes,
      syraEpisodeId: draft.episodeId,
      ingestTicket: draft.ingestTicket,
      ingestTicketExpiresAt: new Date(draft.expiresAt),
      sourceConversationId: input.sourceConversationId,
    });

    // The job id is written in its own statement rather than in the insert,
    // because the queue is keyed by the episode's id — the job cannot exist
    // until the row does.
    const { queued, jobId } = await enqueueShowGeneration({ episodeId: episode.id, userId });
    if (jobId) await updateEpisode(getDb(), episode.id, { jobId });

    res.status(201).json({
      episodeId: episode.id,
      seriesId: series.id,
      episodeNumber,
      // The PLACEHOLDER, echoed so the app can render the queued episode
      // immediately instead of a blank row. It is replaced by the name the
      // script chooses, which arrives with the next read.
      title,
      status: episode.status,
      queued,
    });
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Failed to create a show episode');
    res.status(500).json({
      error: { message: getSafeErrorMessage(error, 'Failed to start the episode'), type: 'server_error' },
    });
  }
});

router.get('/episodes/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Episode');

    const episode = await findEpisodeForUser(getDb(), id, userId);
    if (!episode) return notFound(res, 'Episode');

    res.json(episode);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to read a show episode');
    res.status(500).json({ error: { message: 'Failed to read the episode', type: 'server_error' } });
  }
});

/**
 * Forget an episode.
 *
 * ALIA's record only, for the reason a series delete keeps the podcast: the
 * recording is published on Syra, where people may already be listening to it.
 */
router.delete('/episodes/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    if (typeof id !== 'string') return notFound(res, 'Episode');

    const episode = await findEpisodeForUser(getDb(), id, userId);
    if (!episode) return notFound(res, 'Episode');

    const deleted = await deleteEpisodeForUser(getDb(), id, userId);
    if (!deleted) return notFound(res, 'Episode');

    res.json({
      deleted: true,
      syraEpisodeId: episode.syraEpisodeId,
      syraEpisodeKept: episode.syraEpisodeId !== null,
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to delete a show episode');
    res.status(500).json({ error: { message: 'Failed to delete the episode', type: 'server_error' } });
  }
});

export default router;
