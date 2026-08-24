import { Router } from 'express';
import { SHOW_FORMATS, type ShowFormat } from '../../db/schema/notifications.js';
import { getDb } from '../../db/index.js';
import { storedMediaUrl } from '../../lib/stored-media.js';
import type { ShowSegment } from '../../db/schema/notifications.js';
import {
  countActiveShows,
  createShow,
  deleteShowForUser,
  findShowForUser,
  listShowsForUser,
  updateShow,
} from '../../db/notifications/showRepository.js';
import { enqueueShowGeneration } from '../../lib/show/show-queue.js';
import { SHOW_VOICES, FORMAT_DEFAULTS } from '../../lib/show/voice-roster.js';
import { log } from '../../lib/logger.js';
import { getSafeErrorMessage } from '../../lib/errors/sanitize.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * GET /v1/shows/voices
 * Returns available voice roster for UI selection.
 */
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
 * POST /v1/shows/generate
 * Submit a show generation job.
 *
 * Body: { topic, format?, speakers?, sourceNotes?, sourceConversationId? }
 * Returns: { showId, status: 'queued' }
 */
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { topic, format, sourceNotes, sourceConversationId } = req.body as {
      topic?: string;
      format?: string;
      sourceNotes?: string;
      sourceConversationId?: string;
    };

    if (!topic || topic.trim().length < 5) {
      return res.status(400).json({
        error: { message: 'Topic must be at least 5 characters', type: 'invalid_request_error' },
      });
    }

    if (topic.length > 2000) {
      return res.status(400).json({
        error: { message: 'Topic exceeds 2000 character limit', type: 'invalid_request_error' },
      });
    }

    const showFormat: ShowFormat = SHOW_FORMATS.find((f) => f === format) ?? 'podcast';

    // Check concurrent show limit (max 3 active per user)
    const activeCount = await countActiveShows(getDb(), userId);
    if (activeCount >= 3) {
      return res.status(429).json({
        error: { message: 'Maximum 3 concurrent show generations. Please wait for current ones to finish.', type: 'rate_limit_error' },
      });
    }

    const show = await createShow(getDb(), {
      userId,
      title: `Show: ${topic.slice(0, 80)}`,
      topic: topic.trim(),
      format: showFormat,
      sourceNotes: sourceNotes?.slice(0, 10000),
      sourceConversationId,
    });

    const { queued, jobId } = await enqueueShowGeneration({ showId: show.id, userId });

    if (jobId) {
      await updateShow(getDb(), show.id, { jobId });
    }

    res.status(201).json({
      showId: show.id,
      status: show.status,
      queued,
    });
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Failed to create show');
    res.status(500).json({ error: { message: getSafeErrorMessage(error, 'Failed to create show'), type: 'server_error' } });
  }
});

/**
 * GET /v1/shows
 * List user's shows, paginated.
 */
/**
 * A show, with its audio addressable.
 *
 * `audioUrl` on a show and on each of its segments is a stored KEY — a key is
 * not an address, and this is the only place a show's audio becomes one. A
 * segment or show whose audio cannot be addressed drops the field rather than
 * carrying a string the player cannot fetch.
 *
 * Written out per field rather than by walking the object: a walk that rewrote
 * "anything that looks like a key" would eventually rewrite something that is
 * not one, and which fields hold media is a fact about this shape.
 */
function withAddressableAudio<T extends { audioUrl?: string | null; segments?: ShowSegment[] }>(
  req: Request,
  userId: string,
  show: T,
): T {
  const render = (key: string | null | undefined): string | undefined => {
    if (key === null || key === undefined || key === '') return undefined;
    return storedMediaUrl(req, key, userId) ?? undefined;
  };

  const audioUrl = render(show.audioUrl);
  const segments = show.segments?.map((segment) => {
    const segmentUrl = render(segment.audioUrl);
    const { audioUrl: _stored, ...rest } = segment;
    return segmentUrl === undefined ? rest : { ...rest, audioUrl: segmentUrl };
  }) as ShowSegment[] | undefined;

  const { audioUrl: _showStored, ...rest } = show;
  return {
    ...(rest as T),
    ...(audioUrl === undefined ? {} : { audioUrl }),
    ...(segments === undefined ? {} : { segments }),
  };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.json({ shows: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    // The list projection leaves `segments` out — see the repository.
    const { shows, total } = await listShowsForUser(getDb(), userId, limit, skip);

    res.json({
      shows: shows.map((show) => withAddressableAudio(req, userId, show)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to list shows');
    res.status(500).json({ error: { message: 'Failed to list shows', type: 'server_error' } });
  }
});

/**
 * GET /v1/shows/:id
 * Get a single show with full details.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    if (typeof id !== 'string') {
      return res.status(404).json({ error: { message: 'Show not found', type: 'not_found' } });
    }

    const show = await findShowForUser(getDb(), id, userId);
    if (!show) {
      return res.status(404).json({ error: { message: 'Show not found', type: 'not_found' } });
    }

    res.json(withAddressableAudio(req, userId, show));
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to get show');
    res.status(500).json({ error: { message: 'Failed to get show', type: 'server_error' } });
  }
});

/**
 * DELETE /v1/shows/:id
 * Delete a show.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    if (typeof id !== 'string') {
      return res.status(404).json({ error: { message: 'Show not found', type: 'not_found' } });
    }

    const deleted = await deleteShowForUser(getDb(), id, userId);
    if (!deleted) {
      return res.status(404).json({ error: { message: 'Show not found', type: 'not_found' } });
    }

    // S3 cleanup is left to TTL policies — not worth blocking the response

    res.json({ deleted: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Failed to delete show');
    res.status(500).json({ error: { message: 'Failed to delete show', type: 'server_error' } });
  }
});

export default router;
