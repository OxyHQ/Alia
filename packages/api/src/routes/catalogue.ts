/**
 * `GET /catalogue` — the models Alia offers, as Oxy lists them (ADR 0012).
 *
 * Alia has no models of its own. Every entry is a real `publisher/model` from
 * Oxy's catalogue that a chat turn can run on (text in, text out, tools),
 * with its capabilities, effort levels and prices as the provider publishes
 * them. `featuredIds` and `defaultModelId` are computed
 * (`lib/models/selection.ts`), never curated. The serving operator and
 * deployment ids are never part of the answer.
 *
 * `GET /v1/models` serves the same list in OpenAI's shape.
 */

import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import { listChatModels } from '../lib/models/catalogue.js';
import { getDefaultModelId, getFeaturedModelIds } from '../lib/models/selection.js';
import { toCatalogueResponse } from '../lib/models/wire.js';

const router = Router();

router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const [models, featuredIds] = await Promise.all([listChatModels(), getFeaturedModelIds()]);
    const defaultModelId = models.length === 0 ? null : await getDefaultModelId(req.user?.id ?? null).catch(() => null);
    res.json(toCatalogueResponse(models, featuredIds, defaultModelId));
  } catch (e: unknown) {
    log.models.error({ err: e }, 'Error building the catalogue');
    res.status(503).json({
      error: {
        message: 'The model catalogue is unavailable right now. Please try again.',
        type: 'server_error',
        param: null,
        code: 'catalogue_unavailable',
      },
    });
  }
});

export default router;
