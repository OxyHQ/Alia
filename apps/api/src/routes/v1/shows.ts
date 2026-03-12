import { Router } from 'express';
import { Show } from '../../models/show.js';
import { enqueueShowGeneration } from '../../lib/show/show-queue.js';
import { SHOW_VOICES, FORMAT_DEFAULTS } from '../../lib/show/voice-roster.js';
import { log } from '../../lib/logger.js';
import { sanitizeMessage } from '../../lib/errors/sanitize.js';
import type { Request, Response } from 'express';

const router = Router();

const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

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

    const validFormats = ['podcast', 'news', 'debate', 'interview', 'explainer'];
    const showFormat = validFormats.includes(format || '') ? format! : 'podcast';

    // Check concurrent show limit (max 3 active per user)
    const activeCount = await Show.countDocuments({
      userId,
      status: { $in: ['queued', 'generating_script', 'generating_audio', 'concatenating'] },
    });
    if (activeCount >= 3) {
      return res.status(429).json({
        error: { message: 'Maximum 3 concurrent show generations. Please wait for current ones to finish.', type: 'rate_limit_error' },
      });
    }

    const show = await Show.create({
      userId,
      title: `Show: ${topic.slice(0, 80)}`,
      topic: topic.trim(),
      format: showFormat,
      status: 'queued',
      sourceNotes: sourceNotes?.slice(0, 10000),
      sourceConversationId,
      progress: 0,
    });

    const { queued, jobId } = await enqueueShowGeneration({
      showId: show._id.toString(),
      userId,
    });

    if (jobId) {
      show.jobId = jobId;
      await show.save();
    }

    res.status(201).json({
      showId: show._id.toString(),
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [shows, total] = await Promise.all([
      Show.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-segments') // Exclude segments for list view
        .lean(),
      Show.countDocuments({ userId }),
    ]);

    res.json({
      shows,
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

    const show = await Show.findOne({ _id: req.params.id, userId }).lean();
    if (!show) {
      return res.status(404).json({ error: { message: 'Show not found', type: 'not_found' } });
    }

    res.json(show);
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

    const show = await Show.findOneAndDelete({ _id: req.params.id, userId });
    if (!show) {
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
